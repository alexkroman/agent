// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `testing-events`.
 *
 * Session EVENTS as a spec builds and fires them: `sessionEvent(type, fields,
 * meta)` mints one envelope with the fixed instant and ids a fixture needs, and
 * `fireEvent(agentDef, event, ctx)` runs the handlers the agent declares for it,
 * answering what they did.
 *
 * Its own member of the `testing` family rather than part of `testing` for the
 * reason the others were split off: `testing` is at its export budget, and an
 * event's envelope moves with the event vocabulary (`aai:events`), which has
 * nothing to do with a tool's context. `aai-runtime`'s `testing-stubs` door
 * mirrors the family and so carries these too.
 *
 * Re-exported from `@alexkroman1/aai/testing`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  // `isEvent(e, type)` and `eventsOf(events, type)`: the narrowing reads over a
  // recorded event list, declared in the same module as `sessionEvent`.
  eventsOf,
  type FiredEvent,
  fireEvent,
  isEvent,
  type SessionEventFields,
  type SessionEventRest,
  sessionEvent,
} from "../../sdk/testing-barrel.ts";
