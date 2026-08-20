// Copyright 2026 the AAI authors. MIT license.
/**
 * The session broker: turn a slug into the public session URL a client dials.
 *
 * Split from sandbox-resolve.ts, which answers "which sandbox runs this slug"
 * — this module answers the question the two public entry points actually
 * ask (`GET /:slug/client-config` and the plain `/:slug/websocket` upgrade),
 * which is a URL plus one shared failure taxonomy. It is the platform's ONLY
 * routing point: sessions dial the guest directly afterwards.
 */

import { HTTPException } from "hono/http-exception";
import pTimeout from "p-timeout";
import { BROKER_READY_TIMEOUT_MS } from "./constants.ts";
import { createLogger } from "./logger.ts";
import type { Sandbox } from "./sandbox.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";
import { findPeerSession } from "./sandbox-peers.ts";
import { type ResolveSandboxOpts, resolveSandbox } from "./sandbox-resolve.ts";
import { isLive } from "./sandbox-slots.ts";

const log = createLogger("sandbox.broker");

export type BrokeredSession =
  | { ok: true; sessionUrl: string; guestOrigin: string }
  | { ok: false; status: 404 | 503; cause?: unknown };

/**
 * The session-broker sequence shared by `GET /:slug/client-config` and the
 * plain `/:slug/websocket` upgrade: resolve the slug's live sandbox (booting
 * it on demand) and ask it for its public session URL. One failure taxonomy
 * for both callers — no bundle/sandbox is a 404; a sandbox VM that failed to
 * start is a retryable 503 (the failure hook detaches it, so the next
 * attempt rebuilds).
 *
 * The readiness wait is capped at {@link BROKER_READY_TIMEOUT_MS}, well under
 * the guest's own boot budget: a still-booting sandbox is a retryable 503
 * here, not a two-minute held request. Nothing is torn down on that path —
 * see the constant for why the boot continues and the next call joins it.
 */
export async function brokerSessionUrl(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<BrokeredSession> {
  // Cold on this replica: prefer a live peer replica's guest over spawning a
  // duplicate (see sandbox-directory.ts). Sessions dial the guest directly, so
  // a peer's URL serves the client exactly as well as a local one. A warm
  // local resident always wins — it costs nothing, and the lookup is a
  // round trip on a path where the caller is waiting.
  const resident = opts.slots.get(slug)?.sandbox;
  if (!(resident && isLive(resident))) {
    const peer = await findPeerSession(slug, opts);
    if (peer) return peer;
    // Answer early rather than claiming a slot we are about to abandon. The
    // construction guard in `buildSandboxFromParts` is what actually prevents
    // the orphan; this is the polite 503 — the client re-brokers, and the
    // proxy routes that retry to a live replica.
    if (opts.isDraining?.()) {
      log.debug("Refusing to boot a sandbox while draining", { slug });
      return { ok: false, status: 503 };
    }
  }
  const sandbox = await resolveSandbox(slug, opts);
  if (!sandbox) return { ok: false, status: 404 };
  return await awaitBrokeredUrl(slug, sandbox, opts);
}

/**
 * The sentence a caller gets when the slug's sandbox is not serving yet.
 *
 * One string because it is one condition, and it was spelled out at three call
 * sites across two packages' worth of routes.
 */
export const AGENT_UNAVAILABLE_MESSAGE = "agent unavailable, retry shortly";

/** The sentence for a slug no agent answers to. */
export function notFoundMessage(slug: string): string {
  return `Not found: ${slug}`;
}

/**
 * {@link brokerSessionUrl}, with the failure taxonomy already mapped to an
 * answer: no agent is a 404, anything else is a retryable 503.
 *
 * The taxonomy is this module's — its own doc above says so — but the MAPPING
 * was re-derived by every route that brokers (`/client-config`, the workflow
 * proxy, the webhook proxy), each restating both sentences by hand. Three
 * copies of a two-branch decision is how a rewording reaches two of them, and
 * how the three drift into saying different things about one state.
 *
 * A route that must answer with something other than a thrown `HTTPException`
 * — the webhook proxy adds `Retry-After` — still calls {@link brokerSessionUrl}
 * directly and reuses the two message exports above, so the SENTENCE stays
 * shared even where the shape cannot be. What the two proxies answer after a
 * successful broker is separately theirs: a guest that goes unreachable mid
 * forward is a 503 on the workflow API and a 502 on the webhook, which is a
 * real difference of audience rather than a copy that drifted.
 */
export async function brokerSessionUrlOrThrow(
  slug: string,
  opts: ResolveSandboxOpts,
): Promise<Extract<BrokeredSession, { ok: true }>> {
  const brokered = await brokerSessionUrl(slug, opts);
  if (brokered.ok) return brokered;
  if (brokered.status === 404) throw new HTTPException(404, { message: notFoundMessage(slug) });
  // The sandbox VM failed to start or is still booting; the failure hook
  // detaches it so the next request rebuilds. Tell this caller to retry rather
  // than handing it a URL that will never answer.
  throw new HTTPException(503, { message: AGENT_UNAVAILABLE_MESSAGE, cause: brokered.cause });
}

/**
 * Wait for a resolved sandbox to publish its URLs, within the broker's cap.
 *
 * Split from `brokerSessionUrl` to keep each readable: this half is entirely
 * about the three ways the wait can end (ready, still booting, lost the name
 * race), and the other is about which sandbox to wait on.
 */
async function awaitBrokeredUrl(
  slug: string,
  sandbox: Sandbox,
  opts: ResolveSandboxOpts,
): Promise<BrokeredSession> {
  // Both resolve off the same readiness promise — no extra wait.
  const readyTimeoutMs = opts.readyTimeoutMs ?? BROKER_READY_TIMEOUT_MS;
  const ready = Promise.all([sandbox.sessionUrl(), sandbox.guestOrigin()]);
  // Contained: on the timeout path nothing is awaiting `ready`, and a boot
  // that fails afterwards must not surface as an unhandled rejection.
  ready.catch(() => undefined);
  try {
    const [sessionUrl, guestOrigin] =
      readyTimeoutMs > 0
        ? await pTimeout(ready, {
            milliseconds: readyTimeoutMs,
            message: `sandbox not ready within ${readyTimeoutMs}ms`,
          })
        : await ready;
    return { ok: true, sessionUrl, guestOrigin };
  } catch (err) {
    // Lost the NAME race: a peer created this deploy's sandbox between our
    // directory lookup and the create (sandbox-directory.ts). Go back to the
    // directory rather than retrying a spawn that can only lose again — the
    // peer's guest serves this client exactly as well as a local one.
    if (err instanceof SandboxNameTakenError) {
      log.debug("Lost the sandbox name race; routing to the peer", { slug });
      const peer = await findPeerSession(slug, opts);
      if (peer) return peer;
      // The winner has not published a tunnel yet, or already went away: a
      // retryable 503, exactly like every other still-booting sandbox.
      return { ok: false, status: 503, cause: err };
    }
    // Still booting is not the same as failed to boot, and only the first is
    // worth a quiet line: the failure path already logs (and detaches) via
    // `Sandbox VM failed to start`.
    if (sandbox.alive()) {
      log.debug("Sandbox still booting; answering 503 while it continues", {
        slug,
        waitedMs: readyTimeoutMs,
      });
    }
    return { ok: false, status: 503, cause: err };
  }
}
