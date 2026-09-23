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
 * The agent's OWN custom events — what `ctx.send(event, data)` pushes to the
 * browser — keyed by event name, and EMPTY until the agent declares some.
 *
 * An interface so an agent can augment it, exactly like
 * {@link SessionEventMap}. Once a name is declared, `ctx.send` type-checks its
 * payload: a misspelled field or a wrong type is a compile error in the tool
 * that sends it, rather than a client handler that silently reads `undefined`.
 * A name nobody declared still sends `unknown`, so declaring one event never
 * obliges the agent to declare the rest.
 *
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * declare module "@alexkroman1/aai" {
 *   interface ClientEventMap {
 *     "order.progress": { done: number; total: number };
 *   }
 * }
 *
 * export default tool({
 *   description: "Ship the order",
 *   inputSchema: z.object({}),
 *   execute: (_args, ctx) => {
 *     ctx.send("order.progress", { done: 1, total: 3 });
 *     return { ok: true };
 *   },
 * });
 * ```
 *
 * The payload is typed on the SENDING side only: on the wire it is still a
 * `custom.emitted` frame whose `data` the schema admits as any JSON value.
 *
 * @public
 */
// biome-ignore lint/suspicious/noEmptyInterface: empty on purpose — the declaration authors augment.
export interface ClientEventMap {}

/**
 * What `ctx.send` is: push one custom event to the connected browser client,
 * typed by {@link ClientEventMap}.
 *
 * A name declared in the map must be sent with its declared payload; any other
 * name takes `unknown`. ONE conditional signature rather than a typed overload
 * in front of a `(string, unknown)` fallback, deliberately: with overloads, a
 * DECLARED name sent with the wrong payload fails the first signature and
 * silently resolves against the fallback, so the declaration would type
 * nothing. Any `(event: string, data: unknown) => void` is one of these, which
 * is how the runtime and the test doubles implement it.
 *
 * @public
 */
export type ClientEventSender = <K extends keyof ClientEventMap | (string & {})>(
  event: K,
  data: K extends keyof ClientEventMap ? ClientEventMap[K] : unknown,
) => void;

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
