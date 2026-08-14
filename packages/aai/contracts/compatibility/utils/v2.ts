// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 2 adds `mapInBatches` to epoch 1's surface and takes nothing
 * away, which is why `../utils/v1.ts` is retained rather than dropped — this
 * file only has to demonstrate what is new.
 */

import { mapInBatches } from "../../../sdk/map-in-batches.ts";

/** Bounded fan-out over a list, the shape a workflow body maps its work with. */
export async function cleanSegments(segments: string[]): Promise<string[]> {
  return await mapInBatches(segments, 4, (segment) => segment.trim());
}

/** The index is the item's position in the WHOLE list, not in its batch. */
export async function numbered(items: readonly string[]): Promise<string[]> {
  return await mapInBatches(items, 2, async (item, index) => {
    await Promise.resolve();
    return `${index}: ${item}`;
  });
}
