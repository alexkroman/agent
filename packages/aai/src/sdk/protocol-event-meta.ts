// Copyright 2026 the AAI authors. MIT license.
/**
 * The envelope every session event carries.
 *
 * Its own module because it is UPSTREAM of every event schema, this file's
 * included: an event declared in a second module (see
 * `protocol-events-accounting.ts`) needs the envelope, and while the envelope
 * lived beside the union that meant a runtime import cycle between two modules
 * of eagerly-evaluated zod schemas. `protocol-events.ts` re-exports all three
 * names, so nothing that imported them moved.
 *
 * @module
 */

import { z } from "zod";

/**
 * The prefix every session-event id carries, so an id names its own kind.
 *
 * `evt_` then a ULID — see {@link SessionEventMeta} and its `id` field for what
 * the id is and is not good for. The link names the TYPE rather than the field
 * because the type is `z.infer`red, so TypeDoc documents it as an anonymous
 * object and has no anchor to point a member link at.
 */
export const EVENT_ID_PREFIX = "evt_";

/** Zod schema for {@link SessionEventMeta}. */
export const SessionEventMetaSchema = z.object({
  /**
   * This event's identity, for the whole of its life: `evt_` + a ULID, minted
   * once when the event is written and stored with it.
   *
   * **It is the key for ingesting a stream idempotently, and it is not a
   * cursor.** Three limits come with it, each inherited deliberately rather
   * than rediscovered:
   *
   * - Ids are TIME-ordered, not totally ordered — a session resumed onto a
   *   replacement process mints from a different clock — so `id > $cursor`
   *   drops events. {@link SessionEventEnvelope.index} is the only
   *   authoritative cursor.
   * - It deduplicates DELIVERY, never EXECUTION: retried work re-emits under
   *   fresh ids, so a hook with a non-idempotent side effect keys on the work's
   *   own coordinates (the session, the reply) instead.
   * - It identifies an EVENT, not an intent: one failure legitimately produces
   *   several events, so deduplicating by content would drop real data.
   */
  id: z.string().startsWith(EVENT_ID_PREFIX),
  /** When the event was stamped — epoch milliseconds, the writer's clock. */
  at: z.number().int().nonnegative(),
});

/** The envelope every session event carries. */
export type SessionEventMeta = z.infer<typeof SessionEventMetaSchema>;
