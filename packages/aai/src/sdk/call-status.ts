// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a placed call is, and which of those places are the END — the
 * vocabulary `stepCallStatus` answers in and a polling loop stops on. Split
 * from `step-place-call.ts` at the source-length cap; that module re-exports
 * every name here.
 *
 * @module
 */

/**
 * Where a placed call is. The last five are OVER — nothing moves off them:
 * `completed` (answered and hung up), `busy`, `no-answer`, `failed` (never
 * connected: a bad number, a carrier refusal), `canceled` (hung up by the API
 * before it was answered). Twilio's `initiated` reads as `queued`.
 */
export type PlacedCallStatus =
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "no-answer"
  | "failed"
  | "canceled"
  | (string & {});

/**
 * The {@link PlacedCallStatus} values nothing moves off — `completed`, `busy`,
 * `no-answer`, `failed`, `canceled`. What a loop following a call with
 * {@link stepCallStatus} stops on.
 *
 * Published because every body that dialled wrote its own copy of the list, and
 * a copy missing `canceled` polls a call the API already hung up until its
 * budget runs out.
 *
 * @public
 */
export const CALL_OVER_STATUSES: ReadonlySet<PlacedCallStatus> = new Set<PlacedCallStatus>([
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
]);

/**
 * Whether a call in `status` is over — one of {@link CALL_OVER_STATUSES}.
 *
 * Takes a `string` rather than a {@link PlacedCallStatus} so a loop can start
 * from a status it made up (`"queued"`) or read back from its own store without
 * a cast; anything unknown is not over.
 *
 * @public
 */
export function isCallOver(status: string): boolean {
  return (CALL_OVER_STATUSES as ReadonlySet<string>).has(status);
}
