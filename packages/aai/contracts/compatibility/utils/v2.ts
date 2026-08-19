// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 2.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 2 adds `mapInBatches` to epoch 1's surface and takes nothing
 * away, which is why `../utils/v1.ts` is retained rather than dropped — this
 * file only has to demonstrate what is new.
 */

// The PATH moved when the function was renamed to `mapConcurrent`; the NAME did
// not, which is the whole of what this epoch promised. Following a file rename is
// the one edit a frozen example takes — the import is a relative source path
// because these files are not published, not part of the contract.
//
// `mapInBatches` is `@deprecated` now, and this file goes on importing it: an
// epoch's example is written the way that epoch was authored, so using an API
// deprecated afterwards is what it is FOR. `biome.json` turns
// `noDeprecatedImports` off for `contracts/compatibility/**` rather than each
// such file carrying a suppression, which is the same exemption
// `guard-invariants` makes for this directory and for the same reason.
import { mapInBatches } from "../../../sdk/map-concurrent.ts";

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
