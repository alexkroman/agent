// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `testing` epoch 18.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 18 adds `stubReporter`, which is how a spec asserts what a
 * `"use step"` function narrated and emitted — with nothing published both go to
 * the console, which is right for a step nobody is asserting on and useless the
 * moment the narration is the subject.
 *
 * The shape frozen here is the SPLIT: `lines` is `report()`'s and `emitted` is
 * `emit()`'s, separated the way the streams are, so a spec asserting a partial
 * result never has to filter the sentences out of it.
 */

import { type StubEmitted, type StubReporter, stubReporter } from "../../../sdk/testing.ts";

/** Install it, drive the step, and read back both halves. */
export async function assertNarration(
  runStep: () => Promise<void>,
): Promise<{ lines: string[]; emitted: StubEmitted[] }> {
  const reported: StubReporter = stubReporter();
  try {
    await runStep();
    // Copies, because the arrays go on recording until `restore`.
    return { lines: [...reported.lines], emitted: [...reported.emitted] };
  } finally {
    // Publishing REPLACES, so a spec that forgets this leaves the stub answering
    // the next file's steps.
    reported.restore();
  }
}

/** One chunk, by the stream it went to — what a page subscribes to by name. */
export function transcriptChunks(emitted: readonly StubEmitted[]): unknown[] {
  return emitted.filter((one) => one.namespace === "transcript").map((one) => one.chunk);
}
