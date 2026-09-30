// Copyright 2026 the AAI authors. MIT license.
/**
 * Which CLIENT a session belongs to — the id a device sent as `?client=` on
 * its voice socket, the same id it holds its `WS /inbox` open under.
 *
 * It is what joins the two halves of a push: a tool learns the id here, puts it
 * in a run's input, and the run's step hands it to `stepNotifyClient` hours
 * later, when the session is long gone. `ctx.sessionId` cannot do that job — a
 * session id is minted per conversation and the next one has a new one.
 *
 * A function of the context rather than a field on it (guard-invariants rule
 * 24): it is per-SESSION, and it is reachable from `ctx.sessionId`, a value the
 * tool already holds.
 *
 * ## It is also the key of a durable conversation — and not a credential
 *
 * A session bound to a client keeps its events past its own end, and every
 * later connect naming the same id is seeded with them (`aai-runtime`'s
 * `session-client-history.ts`). So a connect that PRESENTS an id receives that
 * client's history: on a server listening beyond loopback (`AAI_DEV_HOST`,
 * `aai start` behind a LAN address) the id is the only thing standing between
 * a stranger on the network and what the household said. Nothing here
 * authenticates it. Use an id that is not guessable, keep the server on a
 * network you trust, and put real authentication in front of it before
 * exposing it further.
 *
 * ## A global slot, not a module-level map
 *
 * The runtime records the id and a tool reads it, and those are two copies of
 * this module — the agent bundle carries its own — so the map hangs off
 * `globalThis` under a `Symbol.for` key both copies agree on. The same shape as
 * the step slots (`step-env.ts` has the argument), and bounded like
 * `session-location.ts`: a TTL plus a hard cap, so an abandoned process cannot
 * grow it.
 *
 * @module
 */

import type { ToolContext } from "./tool-context.ts";
import { type ToolFailure, toolFailure } from "./utils.ts";

const SESSION_CLIENTS_SLOT = Symbol.for("@alexkroman1/aai.sessionClients");

/** Longer than any session; this only reaps abandoned entries. */
const SESSION_CLIENT_TTL_MS = 86_400_000;
const MAX_SESSION_CLIENTS = 10_000;

type Entry = { clientId: string; expiresAt: number };
type Slot = { [SESSION_CLIENTS_SLOT]?: Map<string, Entry> };

function entries(): Map<string, Entry> {
  const slot = globalThis as Slot;
  slot[SESSION_CLIENTS_SLOT] ??= new Map();
  return slot[SESSION_CLIENTS_SLOT];
}

/**
 * Record the client a session's socket named. A resume that names none keeps
 * the previous one: the caller only calls this with an id.
 *
 * @internal — the runtime's half, called where the session id is decided.
 */
export function setSessionClient(sessionId: string, clientId: string): void {
  const map = entries();
  // Delete-then-set keeps insertion order = least-recently-written first.
  map.delete(sessionId);
  map.set(sessionId, { clientId, expiresAt: Date.now() + SESSION_CLIENT_TTL_MS });
  while (map.size > MAX_SESSION_CLIENTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * The client id this session's device connected with (`?client=` on
 * `WS /websocket`), or `undefined` for a client that sent none — a browser tab,
 * a phone call.
 *
 * Put it in a workflow's input to reach the same device after the session ends:
 *
 * ```ts
 * import { sessionClientId, tool, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const remind = workflow({
 *   input: z.object({ clientId: z.string(), text: z.string() }),
 *   run: async () => ({ delivered: true }),
 * });
 *
 * export default tool({
 *   description: "Remind them about something later, on this speaker.",
 *   inputSchema: z.object({ text: z.string() }),
 *   async execute({ text }, ctx) {
 *     const clientId = sessionClientId(ctx);
 *     if (!clientId) return { error: "This device cannot receive reminders." };
 *     await ctx.workflows.start(remind, { clientId, text });
 *     return { scheduled: true };
 *   },
 * });
 * ```
 */
export function sessionClientId(ctx: Pick<ToolContext, "sessionId">): string | undefined {
  return liveSessionEntry(entries(), ctx.sessionId)?.clientId;
}

/** What {@link requireSessionClient} says by default when a session has no client id. */
const NO_CLIENT_MESSAGE =
  "This only works from a device with its own id, such as a speaker or the page linked to it.";

/**
 * This session's client id ({@link sessionClientId}), or a `ToolFailure`
 * saying why the tool cannot run without one — the guard every tool that keys
 * work by device opens with.
 *
 * ```ts
 * import { requireSessionClient, tool } from "@alexkroman1/aai";
 * import { isToolFailure } from "@alexkroman1/aai/utils";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Email them the last answer.",
 *   inputSchema: z.object({ body: z.string() }),
 *   async execute({ body }, ctx) {
 *     const clientId = requireSessionClient(ctx, "Email works on a speaker only.");
 *     if (isToolFailure(clientId)) return clientId;
 *     return { queued: body.length, for: clientId };
 *   },
 * });
 * ```
 *
 * @param message - The sentence the model reads when there is no client id.
 */
export function requireSessionClient(
  ctx: Pick<ToolContext, "sessionId">,
  message: string = NO_CLIENT_MESSAGE,
): string | ToolFailure {
  return sessionClientId(ctx) ?? toolFailure(message);
}

/**
 * A per-session entry that has not outlived its TTL, reaping it if it has — the
 * read side every bounded session map here shares (`session-phone.ts` too).
 *
 * @internal
 */
export function liveSessionEntry<E extends { expiresAt: number }>(
  map: Map<string, E>,
  sessionId: string,
): E | undefined {
  const entry = map.get(sessionId);
  if (!entry) return;
  if (entry.expiresAt <= Date.now()) {
    map.delete(sessionId);
    return;
  }
  return entry;
}
