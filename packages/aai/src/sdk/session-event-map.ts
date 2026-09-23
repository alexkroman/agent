// Copyright 2026 the AAI authors. MIT license.
/**
 * The session event vocabulary as a MAP — one entry per event name — and every
 * type the rest of the SDK, the runtime and the specs read events through.
 *
 * ## Why a map, and why here
 *
 * Every consumer of the vocabulary used to restate it. `agent({ events })` keyed
 * its handlers off `SessionEvent["type"]`, a dialog's `@` names were a template
 * literal over the same union, `aai-runtime` spelled the fourteen events a
 * transport may report out as a literal list, and specs narrowed with
 * `Extract<SessionEvent, { type: "tool.called" }>` wherever they needed one
 * member. Worse, the union itself was exported only from the non-authoring
 * `/protocol` subpath, so NO capability contract owned it: its body was hashed
 * in full by every capability that reached it, and one new event
 * (`user-turn.exceeded`, `metrics.collected`) bumped `aai:agent`, `aai:dialog`,
 * `aai:testing` and `aai-runtime:session` at once.
 *
 * Now the zod schema is the one source of truth, {@link SessionEventMap} is
 * derived from it here, and every other name is a lookup into the map:
 * `SessionEvent<"tool.called">` is one member, `SessionEventType` the key set,
 * `SessionEventBody<K>` a member without its envelope. The whole family is
 * owned by the `aai:events` capability, so a new event is ONE classification.
 *
 * ## The map is an interface, so it can be augmented
 *
 * `interface SessionEventMap` rather than a type alias: a host that ships an
 * event of its own can declare it with module augmentation and have
 * `SessionEvent`, `SessionEventType` and the handler map pick it up. Only the
 * TYPES widen — the schema still validates the wire — so an augmented event is
 * the augmenting package's to emit and to parse.
 *
 * @module
 */

import type { z } from "zod";
import type { SessionEventSchema } from "./protocol-events.ts";

/**
 * Key a union of `{ type }` members by their `type`.
 *
 * What {@link SessionEventMap} is derived through, and exported so a host with
 * a vocabulary of its own can build the same shape for it.
 *
 * @public
 */
export type EventMapOf<U extends { type: string }> = { [E in U as E["type"]]: E };

/**
 * Every session event, keyed by its `type` — derived from `SessionEventSchema`.
 *
 * Read one member with `SessionEvent<"tool.called">`, never with
 * `Extract<SessionEvent, { type: … }>`: the lookup fails to compile on a
 * misspelled name, where the `Extract` silently resolves to `never`.
 *
 * @public
 */
export interface SessionEventMap extends EventMapOf<z.infer<typeof SessionEventSchema>> {}

/**
 * Every event name a handler map, a dialog's `@` keys or a spec may name.
 *
 * Name it to write a list of event names down in your own code:
 *
 * ```ts
 * import type { SessionEventType } from "@alexkroman1/aai";
 *
 * const AUDITED: readonly SessionEventType[] = ["tool.called", "error.reported"];
 * ```
 *
 * @public
 */
export type SessionEventType = Extract<keyof SessionEventMap, string>;

/**
 * One **server→client** session event, envelope included: a fact the session
 * reports, in the shape it takes on the wire and in the retained stream.
 *
 * Bare, it is the whole union — what a `"*"` handler receives and what a client
 * parses. With a name (or a union of names) it is just those members.
 * Host code EMITS a {@link SessionEventBody} and the session's emitter stamps
 * the envelope — see `protocol-events.ts`.
 *
 * @public
 */
export type SessionEvent<K extends SessionEventType = SessionEventType> = SessionEventMap[K];

/**
 * A session event as its EMITTER writes it — everything but the `meta`
 * envelope, which the session stamps exactly once. Distributes over `K`, so
 * each member keeps its own `type`.
 *
 * @public
 */
export type SessionEventBody<K extends SessionEventType = SessionEventType> = {
  [T in K]: Omit<SessionEventMap[T], "meta">;
}[K];

/**
 * The events only the SESSION itself can be the source of — never a transport.
 *
 * The complement of what `aai-runtime`'s `TransportEventBody` accepts, and the
 * one place that decision is written down, so a new event is REPORTABLE by
 * default — the session publishes a report it has no `case` for — and needs
 * no edit to a list in another package. Each is here for a reason:
 * `session.configured` is the handshake, `session.reset` and
 * `session.timed-out` come from the client and the idle watchdog,
 * `custom.emitted` is `ctx.send`, `state.updated` is a `syncState` projection,
 * `usage.updated` and `guardrail.blocked` are the session's own accounting and
 * refusals, and `history.restored` is a resume.
 *
 * @public
 */
export const SESSION_SOURCED_EVENT_TYPES = [
  "session.configured",
  "session.reset",
  "session.timed-out",
  "custom.emitted",
  "state.updated",
  "usage.updated",
  "guardrail.blocked",
  "history.restored",
] as const satisfies readonly SessionEventType[];

/**
 * One of {@link SESSION_SOURCED_EVENT_TYPES}.
 *
 * @public
 */
export type SessionSourcedEventType = (typeof SESSION_SOURCED_EVENT_TYPES)[number];
