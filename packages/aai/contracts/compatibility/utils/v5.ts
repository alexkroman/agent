// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 5.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 5 adds what a step SAYS and what it does with a failure —
 * `report`, and the `isTransientStatus`/`retryAfter` pair — to epoch 4's and
 * takes nothing away, so this file only demonstrates what is new.
 */

import { isTransientStatus, report, retryAfter } from "../../../sdk/utils.ts";

/**
 * The narration a fan-out owes its reader: one line per unit of work, from a
 * STEP and never from the body, which replays.
 */
export async function transcribeSegment(index: number, total: number): Promise<void> {
  "use step";

  await report(`Transcribing segment ${index + 1} of ${total}.`);
}

/** What a step tells the DevKit about a failed HTTP call. */
export type RetryPlan = { retry: false } | { retry: true; at: Date | undefined };

/**
 * The decision every step that calls an API makes: give up, retry on the
 * DevKit's own backoff, or retry when the far side asked to be called back.
 */
export function planRetry(response: Response): RetryPlan {
  if (!isTransientStatus(response.status)) return { retry: false };
  return { retry: true, at: retryAfter(response) };
}
