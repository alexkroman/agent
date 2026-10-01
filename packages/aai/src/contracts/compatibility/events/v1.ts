// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:events` epoch 1.
 *
 * Epoch 2 added one event to the vocabulary, `provider.failed-over` (what a
 * `fallback([...])` stage reports when it switches provider). A grown map is
 * not assignable to the one it grew from, so the probe cannot call it a
 * revision — but nothing an epoch-1 author WROTE stops compiling: a handler map
 * names the events it handles, a `"*"` handler takes whatever arrives, a list
 * of event names is still a list of valid names, and `SessionEventSchema`
 * still parses every frame epoch 1 knew. What this pins is that code.
 *
 * The one shape that does break is an EXHAUSTIVE `switch` over
 * `SessionEvent["type"]` ending in `never`, which is why the epoch moved at
 * all; this example deliberately does not contain one, because that is the
 * code a new event is SUPPOSED to stop compiling until it is handled.
 *
 * It names every one of epoch 1's 12 exports (`api-contracts-gate.test.ts`)
 * and imports them by RELATIVE path, so it proves epoch 1's surface compiles
 * against current source rather than against the current build.
 *
 * @module
 */

import type {
  ClientEventMap,
  ClientEventSender,
  EventMapOf,
  SessionEvent,
  SessionEventBody,
  SessionEventHandler,
  SessionEventHandlers,
  SessionEventMap,
  SessionEventType,
  SessionSourcedEventType,
} from "../../../index.ts";
import { SESSION_SOURCED_EVENT_TYPES, SessionEventSchema } from "../../../index.ts";

// A handler map that names the events it cares about, typed per event.
export const events: SessionEventHandlers = {
  "tool.called": (event) => {
    const name: string = event.toolName;
    return name;
  },
  "user-turn.exceeded": (event) => event.words,
  "*": (event) => event.type,
};

// One handler, declared on its own and narrowed with the map lookup.
export const onError: SessionEventHandler<SessionEvent<"error.reported">> = (event) =>
  event.message;

// A list of event names written down in the author's own code.
export const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];

// What an emitter writes, without its envelope.
export const body: SessionEventBody<"reply.completed"> = { type: "reply.completed" };

// The map, read by key.
export type ToolCalled = SessionEventMap["tool.called"];

// A host's own vocabulary, keyed the same way.
export type HostEvents = EventMapOf<{ type: "host.ping" } | { type: "host.pong"; at: number }>;

// The session-sourced names, as a value and as their type.
export const sourced: readonly SessionSourcedEventType[] = SESSION_SOURCED_EVENT_TYPES;

// `ctx.send`'s type: any name, payload typed by `ClientEventMap` once declared.
export function announce(send: ClientEventSender, map?: ClientEventMap): void {
  send("order.progress", { done: 1, total: 3 });
  void map;
}

// The schema still parses a frame epoch 1 knew.
export const parsed = SessionEventSchema.safeParse({
  type: "reply.completed",
  meta: { id: "evt_1", at: 0 },
}).success;
