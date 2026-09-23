// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `events`.
 *
 * The session event vocabulary — the schema, the {@link SessionEventMap} derived
 * from it, and every name read through that map — plus the handler types an
 * `agent({ events })` declaration is keyed by.
 *
 * **Why this is its own capability, and why the types moved to the root.** The
 * union used to be exported only from `/protocol`, a NON-authoring subpath, so no
 * capability could select it. An ownerless declaration is hashed by body in
 * every capability that reaches it, and this one was reached by `agent` (the
 * handler map), `dialog` (`Dialog.receive` and the `@` names), `metrics` (the
 * frame's type) and — through `TransportEventBody`'s hand-written list —
 * `aai-runtime:session`: `user-turn.exceeded` and `metrics.collected` each bumped
 * all four. Contracting `/protocol` instead would have made every wire export
 * authoring surface and pulled it into the template-coverage ratchet, so the
 * vocabulary moved to the root barrel, where an author already met it through
 * `events`, and `/protocol` keeps the envelope, the commands and the parsers.
 *
 * A new event is now a change to ONE capability. It is still a classification —
 * a union that grows is not mutually assignable to the one it grew from, and a
 * consumer switching exhaustively over `SessionEventType` does break — but it is
 * one epoch rather than four, and everything else names the event through this
 * map rather than restating it, so its hash does not move at all.
 *
 * `SessionEventContext` is NOT here: it is the twin of `AgentSessionContext` and
 * stays beside it on `agent`, for the reason that capability's note gives.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type ClientEventMap,
  type ClientEventSender,
  type EventMapOf,
  SESSION_SOURCED_EVENT_TYPES,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventHandler,
  type SessionEventHandlers,
  type SessionEventMap,
  SessionEventSchema,
  type SessionEventType,
  type SessionSourcedEventType,
} from "../../index.ts";
