// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform's client of a guest's `/manage/logs`, and the shape it hands on.
 *
 * Its own module rather than another method body in `warm-harness.ts` for the
 * ordinary reason (that file is near the length cap), and one substantive one:
 * the CALLER of this is a user-facing route, where `activeSessions` and `drain`
 * beside it are operational. The failure policies differ accordingly — an
 * unreachable guest reads as "no logs yet" here, because a pane that says
 * `Failed to load` when the agent simply is not running teaches the user to
 * distrust it, while retirement genuinely needs `drain` to reject.
 *
 * ## What a caller is promised
 *
 * A {@link LogPage} straight from the guest's ring: `lines` after the cursor
 * they passed, the `cursor` to pass next, and `dropped` — how many lines fell
 * out of the ring before they got to them. The last one is the reason this is
 * not just an array. A tail that silently skips is indistinguishable from an
 * agent that went quiet, and the pane says so out loud.
 *
 * @module
 */

import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import type { LogLine, LogPage, LogStream } from "@alexkroman1/aai-runtime";
import { MANAGE_REQUEST_TIMEOUT_MS } from "./constants.ts";
import type { AppContext } from "./context.ts";
import { GUEST_ROUTES, guestHttpUrl } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import { agentSandboxName, type SandboxDirectory } from "./sandbox-directory.ts";
import { isLive, type SlotCache } from "./sandbox-slots.ts";
import type { BundleStore } from "./store-types.ts";

const log = createLogger("agent.logs");

/** What one read of a guest's ring needs. */
export type ReadGuestLogsOpts = {
  /** The guest's origin, as `Sandbox.guestOrigin()` reports it. */
  guestOrigin: string;
  /** The per-sandbox bearer gating `/manage/*`. */
  token: string;
  /** Read lines after this seq. `-1` (the default) reads from the oldest held. */
  after?: number;
  limit?: number;
  fetchFn?: typeof globalThis.fetch | undefined;
};

/**
 * How long a log read may wait on a sandbox that is still BOOTING.
 *
 * Deliberately short, and deliberately not the readiness budget: a pane polls,
 * so a poll that waits out a cold boot is a pane that hangs for two minutes on
 * exactly the agent whose output the user wants. An empty page and another poll
 * a second later is the better answer, and the pane says "starting" from the
 * sandbox's own liveness rather than from this.
 *
 * It lives here rather than in `constants.ts` because it is this concern's
 * number and that file is at its length cap.
 */
export const LOGS_READY_TIMEOUT_MS = 2000;

/** An empty page that holds the caller's cursor — see {@link readGuestLogs}. */
export function emptyLogPage(after = -1): LogPage {
  return { lines: [], cursor: after, dropped: 0 };
}

/**
 * Read a guest's buffered output.
 *
 * NEVER throws: a guest that is booting, gone, or answering nonsense yields an
 * empty page at the caller's own cursor, so a poller neither rewinds nor
 * crashes. The distinction the pane needs — "not running" versus "running and
 * silent" — is the sandbox's `alive()`, which the route already knows and this
 * function deliberately does not duplicate.
 */
export async function readGuestLogs(opts: ReadGuestLogsOpts): Promise<LogPage> {
  const after = opts.after ?? -1;
  const query = new URLSearchParams({ after: String(after) });
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(
      `${guestHttpUrl(opts.guestOrigin, GUEST_ROUTES.manageLogs)}?${query}`,
      {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(MANAGE_REQUEST_TIMEOUT_MS),
      },
    );
    // A 404 is the honest answer from a guest running a harness image PINNED
    // before this route existed — deployed agents outlive platform versions by
    // design. An empty pane is the right degradation; an error is not.
    if (!res.ok) return emptyLogPage(after);
    return parseLogPage(await res.json(), after);
  } catch (err) {
    log.debug("guest log read failed", { error: errorMessage(err) });
    return emptyLogPage(after);
  }
}

/**
 * Validate what the guest sent.
 *
 * Guest-asserted wire data, so every field consumed is checked — but the blast
 * radius is one tenant reading its own output, so a malformed page degrades to
 * empty rather than raising. Lines that do not parse are DROPPED individually:
 * one bad entry must not hide the good ones around it, which is the same rule
 * the buffer's own reader follows.
 */
export function parseLogPage(body: unknown, after: number): LogPage {
  if (!(isRecord(body) && Array.isArray(body.lines))) return emptyLogPage(after);
  const lines = body.lines.filter(isLogLine);
  return {
    lines,
    // Trust the guest's cursor only as far as it is a number that does not go
    // BACKWARDS: a rewinding cursor would make a poller replay forever.
    cursor: typeof body.cursor === "number" ? Math.max(body.cursor, after) : after,
    dropped: typeof body.dropped === "number" && body.dropped > 0 ? body.dropped : 0,
  };
}

const STREAMS = new Set<string>(["stdout", "stderr"] satisfies LogStream[]);

function isLogLine(value: unknown): value is LogLine {
  return (
    isRecord(value) &&
    typeof value.seq === "number" &&
    typeof value.at === "number" &&
    typeof value.text === "string" &&
    typeof value.stream === "string" &&
    STREAMS.has(value.stream)
  );
}

// ── The platform route: GET /:slug/logs ──────────────────────────────────────

/**
 * What the route answers with: the guest's page plus whether there is a guest.
 *
 * `running` is the field the pane cannot do without. An empty page has two
 * meanings — "this agent is up and has printed nothing" and "nothing is running
 * to print" — and they call for opposite things from the reader (wait, versus
 * send it a request). Without it a pane has to guess, and it guesses wrong on
 * the first open of every agent.
 */
export type AgentLogsResponse = LogPage & { running: boolean };

/** What the route needs to find a slug's guest without booting one. */
export type AgentLogsEnv = {
  slots: SlotCache;
  store: Pick<BundleStore, "getAgentVersion">;
  directory?: SandboxDirectory | undefined;
};

/**
 * Read a deployed agent's buffered output.
 *
 * **This route never BOOTS a sandbox**, which is what separates it from every
 * other `/:slug/*` route. Reading a log is a diagnostic, and a diagnostic that
 * starts the thing it is diagnosing answers a different question than the one
 * asked — it would also let a poll loop keep an idle agent alive indefinitely
 * and bill the tenant for it. A slug with no live guest anywhere answers
 * `running: false` and an empty page.
 *
 * Two ways a guest is found, in the order they cost:
 *
 * 1. **This replica's resident**, straight out of the slot cache.
 * 2. **A peer's**, through the fleet-wide directory — the same lookup the
 *    broker's cold path makes. Reaching it needs the manage bearer, which is
 *    why that token is DERIVED from the sandbox name rather than drawn at
 *    random (`guest-token.ts`); before that it was unreadable from anywhere but
 *    the replica that spawned it.
 */
export async function readAgentLogs(
  env: AgentLogsEnv,
  slug: string,
  opts: { after?: number; limit?: number } = {},
): Promise<AgentLogsResponse> {
  const after = opts.after ?? -1;
  const resident = env.slots.get(slug)?.sandbox;
  if (resident && isLive(resident)) {
    // `running` is true even for a resident that cannot answer: it IS running,
    // which is the question this field asks, and a stand-in with no `logs` is a
    // test double rather than a state the pane has to explain.
    return { ...(await (resident.logs?.(opts) ?? emptyLogPage(after))), running: true };
  }
  const peer = await findPeerGuest(env, slug);
  if (!peer) return { ...emptyLogPage(after), running: false };
  return {
    ...(await readGuestLogs({ ...peer, ...opts })),
    running: true,
  };
}

/**
 * A live peer sandbox's origin plus the token that opens its manage surface.
 *
 * Best-effort in the same sense `findPeerSession` is: any trouble reads as "no
 * peer", because the alternative is failing a diagnostic read over a directory
 * blip. The version read is also the EXISTENCE gate — a deleted agent's sandbox
 * can still be draining, and its logs are not this slug's any more.
 */
async function findPeerGuest(
  env: AgentLogsEnv,
  slug: string,
): Promise<{ guestOrigin: string; token: string } | null> {
  const directory = env.directory;
  if (!directory) return null;
  try {
    const version = await env.store.getAgentVersion(slug);
    if (version === null) return null;
    const peer = await directory.find(slug, version);
    if (!peer) return null;
    return {
      guestOrigin: peer.guestOrigin,
      token: guestTokenFor(agentSandboxName(slug, version)),
    };
  } catch (err) {
    log.debug("peer lookup for logs failed", { slug, error: errorMessage(err) });
    return null;
  }
}

/**
 * `GET /:slug/logs` — owner-authenticated, same posture as the secret routes.
 *
 * A FACTORY, because the slot cache and the fleet-wide directory are
 * server-level singletons the orchestrator holds rather than Hono bindings
 * (`context.ts` deliberately carries neither — same shape as
 * `createAgentClientConfigHandler`).
 */
export function createAgentLogsHandler(
  deps: Omit<AgentLogsEnv, "store">,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const query = new URL(c.req.url).searchParams;
    const after = Number(query.get("after"));
    const limit = Number(query.get("limit"));
    return c.json(
      await readAgentLogs({ ...deps, store: c.env.store }, c.var.slug, {
        // Same tolerance as the guest's own parser, and the same trap:
        // `Number(null)` is 0, so an ABSENT cursor has to be rejected before the
        // numeric check or a first read silently skips the guest's first line.
        after: query.get("after") !== null && Number.isInteger(after) && after >= 0 ? after : -1,
        ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      }),
    );
  };
}
