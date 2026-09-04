// Copyright 2026 the AAI authors. MIT license.
/**
 * The bearer check every GUEST-CALLED route on `/:slug` shares.
 *
 * Four identical copies of this function existed — in the session-state, enqueue,
 * run-storage and run-stream handlers — byte for byte, and a fifth was about to be
 * written for uploads. That is the shape this repo's guide calls a missing typed
 * seam: not a cast, but the same reasoning restated until one copy drifts.
 *
 * ## What it decides, and why each answer is the status it is
 *
 * The token is `HMAC(secret, agentSandboxName(slug, version))` — deterministic
 * across replicas, so any replica can verify a bearer minted by whichever one
 * spawned the guest, with no shared state (`guest-token.ts`).
 *
 * - **No header, or an empty one → 401.** Not 400: the caller supplied no
 *   credential, which is the ordinary unauthenticated case.
 * - **No such agent → 404.** A delete leaves NO TOMBSTONE: the agents row is gone
 *   and all ten tenant tables cascade off it, so a deleted slug and a
 *   never-deployed slug are the same absent row and there is no later in which
 *   either becomes servable. This answered 503, on the ground that a 404 "would
 *   tell an unauthenticated caller whether a slug exists, which every other route
 *   on this surface refuses to do". Both halves of that are false, which is why
 *   it moved:
 *
 *   - **The oracle was already open, one status over.** The token compare below
 *     answers 401, so a caller sending `Authorization: Bearer x` got 401 for a
 *     slug that exists and 503 for one that does not. The distinction was fully
 *     legible; only its labelling was coy. (What the ORDER protects is narrower
 *     and still holds — see the position note below.)
 *   - **Every other route on this surface discloses it deliberately.**
 *     `brokerSessionUrlOrThrow` answers `Not found: <slug>` to an unauthenticated
 *     `GET /:slug/client-config`, and `upload-handler.ts`'s `assertAgentExists`
 *     does the same. Slug existence is public here by design.
 *
 *   And 503 is not free: it is the platform claiming a fault of its own, so
 *   `error-handler.ts` writes a warn line per request for a condition no operator
 *   can act on, while telling the caller to come back. A redeploy cannot produce
 *   it — the agents row is written `on conflict (slug) do update set`, so the row
 *   never transiently vanishes and `null` only ever means gone.
 *
 *   **What the GUEST does with either is the same thing**, which is what made the
 *   move safe rather than merely correct: `platformPost`
 *   (`aai-runtime/platform-rpc.ts`) throws one generic `Error` naming the status
 *   for every non-2xx, and of the four guest-called routes only the upload-records
 *   client reads a status at all (409 and 501). Nothing on this path retries on a
 *   5xx or gives up on a 4xx, so the status reaches a log line and no decision.
 * - **A mismatch → 401, compared in CONSTANT TIME.** `constantTimeEquals`, because
 *   an early-exit compare on a 64-hex HMAC leaks it a nibble at a time to a caller
 *   who can time the reply, and these routes are reachable from the tunnel.
 *
 * ## Why it takes the Context rather than the token
 *
 * The alternative — a caller extracting the header and passing a string — puts the
 * "did you remember to strip `Bearer `" step at five call sites. The whole point is
 * that a route asks one question and gets the whole policy. The strip itself is
 * `parseBearer` (`@alexkroman1/aai-runtime/internal`, shared with `middleware.ts`
 * and with both gates in the runtime and the guest): it answers `""` for a header
 * that is not a Bearer credential, where a `.replace(/^Bearer /, "")` would hand
 * the raw header on as if it were the token.
 *
 * ## Its expected value cannot be blank, and that is a property rather than luck
 *
 * `bearerMatches` in the runtime had to be taught to refuse a blank expected
 * secret — `timingSafeEqual` on two empty buffers MATCHES, so a set-but-empty
 * `AAI_SESSION_EVENTS_TOKEN` authenticated a request with no header at all. This
 * gate is safe from that by two independent facts: the `supplied === ""` refusal
 * happens FIRST, so no caller reaches the compare without a token, and
 * `guestTokenFor` returns a 64-hex HMAC digest which is never empty. The
 * `supplied` check is therefore not merely a fast path for the ordinary
 * unauthenticated case — it is what makes an empty comparison unreachable.
 *
 * What its POSITION buys is a different property, and only one case shows it:
 * moving it below the not-found answer tells a caller who supplied NO credential
 * at all whether a slug exists. That is a real if narrow line to hold — every
 * other route on this surface answers such a caller from its own policy, and this
 * gate should not become a second, quieter way to ask — and it survives the 503 →
 * 404 move above unchanged, because it is about which refusal WINS rather than
 * about what the loser says. Moving the check below the version READ alone
 * changes nothing observable (A/B'd), so the rule is about order, not the query.
 *
 * @internal
 */

import { parseBearer } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { constantTimeEquals } from "./_timing-safe.ts";
import type { AppContext } from "./context.ts";
import { guestTokenFor } from "./guest-token.ts";
import { agentSandboxName } from "./sandbox-directory.ts";

/**
 * Throw unless this request carries the bearer `slug`'s running guest would hold.
 *
 * @internal
 */
export async function assertGuestBearer(c: AppContext, slug: string): Promise<void> {
  const refusal = await guestBearerRefusal({
    authorization: c.req.header("authorization"),
    slug,
    getAgentVersion: (s) => c.env.store.getAgentVersion(s),
  });
  if (refusal !== undefined) {
    throw new HTTPException(refusal.status, { message: refusal.message });
  }
}

/** How a refusal is reported to a caller that is not holding a Hono context. */
export type GuestBearerRefusal = { status: 401 | 404; statusText: string; message: string };

/**
 * The policy itself, over the header rather than over a request.
 *
 * Split out for ONE caller that has no `Context` and must not have a second copy
 * of this: the `WS /:slug/platform-socket` handshake
 * (`platform-socket-handler.ts`), which is answered from the raw `upgrade` event
 * before any router has run. The module doc above is the argument for why the
 * four route-side copies were folded into one; a fifth copy behind a WebSocket
 * would be the same mistake with a worse failure mode, since a handshake that
 * checks a bearer differently from the routes underneath it is a door that opens
 * on credentials the rooms refuse.
 *
 * `undefined` means "authorized". `getAgentVersion` is passed rather than a store
 * because that is the whole of what this reads.
 *
 * @internal
 */
export async function guestBearerRefusal(opts: {
  authorization: string | undefined;
  slug: string;
  getAgentVersion: (slug: string) => Promise<number | null>;
}): Promise<GuestBearerRefusal | undefined> {
  const supplied = parseBearer(opts.authorization);
  if (supplied === "") {
    return { status: 401, statusText: "Unauthorized", message: "unauthorized" };
  }
  const version = await opts.getAgentVersion(opts.slug);
  // 404 and not 503: there is no tombstone, so "later" is not a thing this row
  // has. See the module doc for why the existence-oracle argument for the 503
  // did not survive contact with the 401 one line down.
  //
  // The sentence matches `notFoundMessage()` in `sandbox-broker.ts` — one
  // condition should read the same however a caller reached it — and is spelled
  // rather than imported deliberately: that module pulls in `sandbox.ts`,
  // `p-timeout` and the peer directory, and an auth gate every guest-called route
  // runs first should not depend on the sandbox layer to name a status.
  if (version === null) {
    return { status: 404, statusText: "Not Found", message: `Not found: ${opts.slug}` };
  }
  if (!constantTimeEquals(supplied, guestTokenFor(agentSandboxName(opts.slug, version)))) {
    return { status: 401, statusText: "Unauthorized", message: "unauthorized" };
  }
  return undefined;
}
