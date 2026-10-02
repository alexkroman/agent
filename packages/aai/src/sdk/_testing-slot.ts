// Copyright 2026 the AAI authors. MIT license.
/**
 * The recording-slot shape every published-slot fake shares (`stubClientInbox`,
 * `stubClientTranscript`, `stubSpeech`, `stubReporter`): publish a function
 * that logs each call and answers it, and hand back the log and the unpublish.
 *
 * @module _testing-slot
 */

/** What {@link recordingSlot} returns. */
export interface RecordingSlot<Call> {
  /** Every call, in order. */
  calls: Call[];
  /** Unpublish the slot. */
  restore: () => void;
}

/**
 * Publish `answer` behind a recorder: each call is turned into a `Call` by
 * `record`, logged, then answered. `wrap` adapts the published function (e.g.
 * `keylessSynthesizer`) without moving the recording out of it.
 */
export function recordingSlot<Args extends unknown[], Call, Result>(
  publish: (fn: ((...args: Args) => Result) | undefined) => void,
  record: (...args: Args) => Call,
  answer: (call: Call) => Result,
  wrap: (fn: (...args: Args) => Result) => (...args: Args) => Result = (fn) => fn,
): RecordingSlot<Call> {
  const calls: Call[] = [];
  publish(
    wrap((...args) => {
      const call = record(...args);
      calls.push(call);
      return answer(call);
    }),
  );
  return { calls, restore: () => publish(undefined) };
}
