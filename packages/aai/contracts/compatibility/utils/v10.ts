// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 10.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 10 adds two things a step body reaches for, and takes nothing
 * away — `../utils/v9.ts` is retained rather than dropped, and `mapInBatches` is
 * still exported under its old name for exactly that reason.
 *
 * `emit` is the one worth freezing carefully: the namespace is a REQUIRED
 * positional argument, because the default stream is `report()`'s and an object
 * written into it renders as `[object Object]` in the middle of a page's progress
 * log. A later signature that made it optional would break every reader that
 * assumed one stream carries one shape.
 */

import { emit, mapConcurrent, report } from "../../../sdk/utils.ts";

/** One piece of work, and what a reader of the stream sees of it. */
type Piece = { index: number; text: string };

/**
 * The shape a workflow body fans out with: bounded, and each result handed over
 * as it lands rather than at the end.
 */
export async function transcribeAll(segments: readonly number[]): Promise<Piece[]> {
  return await mapConcurrent(segments, 4, (segment, index) => transcribeOne(segment, index));
}

/** The step: a sentence for a person, then a value for a program. */
async function transcribeOne(segment: number, index: number): Promise<Piece> {
  await report(`Transcribing segment ${index}.`);
  const piece: Piece = { index, text: `segment ${segment}` };
  // Namespace FIRST and required — see the module doc.
  await emit("transcript", piece);
  return piece;
}
