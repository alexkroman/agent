// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 11.
 *
 * Epoch 11 gave an agent a way to OBSERVE ITSELF: `events`, a handler per session
 * event type plus a `"*"` catch-all, keyed against the same vocabulary the wire
 * carries. Before it there was no such surface at all — the framework held 51
 * internal `on*` callback options and not one was reachable from an `agent.ts`.
 *
 * Purely additive, which is why epoch 10 is RETAINED rather than dropped: the
 * field is optional and `./v10.ts` compiles unchanged beside this file.
 *
 * The epoch carries the three handler TYPES as well as the field, and this
 * example is written to need them: they are what an author names the moment a
 * handler is extracted from the object literal into a function of its own, which
 * is the first thing that happens once one grows past a line. `SessionEvent`
 * itself is not part of this capability — it is the wire union, imported from
 * `@alexkroman1/aai/protocol` exactly as a client imports it.
 *
 * Three rules the type cannot express, and which this example respects: a handler
 * is OBSERVE-ONLY (it cannot inject context, alter a reply, or cancel), a throw is
 * NON-FATAL and the session continues, and delivery is at-least-once with
 * `meta.id` as the key.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
} from "../../../index.ts";
import { agent, sessionSlot } from "../../../index.ts";
import type { SessionEvent } from "../../../sdk/protocol.ts";

const auditSlot = sessionSlot("audit", () => ({ seen: [] as string[] }));

/**
 * A handler extracted into a named function — the case the exported types exist
 * for. Narrowed to one member of the union, so `toolName` is reachable with no
 * cast.
 */
const onToolCalled: SessionEventHandler<Extract<SessionEvent, { type: "tool.called" }>> = (
  event,
  ctx: SessionEventContext,
) => {
  // `meta.id` is the de-duplication key: delivery is at-least-once.
  console.log(ctx.sessionId, event.meta.id, event.toolName);
};

/** The whole table, named — what a project with more than one handler declares. */
const handlers: SessionEventHandlers = {
  "tool.called": onToolCalled,
  // The catch-all sees the full union, so only the envelope and the discriminant
  // are common to every member.
  "*": (event) => {
    console.log(event.meta.at, event.type);
  },
  // Async and throwing are both legal: neither is awaited, and a throw is logged
  // against the event rather than ending the session.
  "session.configured": async (event) => {
    await Promise.resolve();
    if (event.sampleRate === 0) throw new Error("logged, not fatal");
  },
};

export default agent({
  name: "Observed",
  greeting: "What can I get you?",
  events: handlers,
  syncState: auditSlot.projection((audit) => ({ count: audit.seen.length })),
});

/** The inline form, which is what a single handler looks like. */
export const inline = agent({
  name: "Inline",
  events: { "reply.completed": (event) => void event.meta.id },
});
