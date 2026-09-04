// Copyright 2026 the AAI authors. MIT license.
/**
 * `JSON.parse` that answers rather than throws.
 *
 * Its own module rather than a function in `sdk/utils.ts`, and the reason is
 * mechanical: `utils.ts` re-exports {@link import("./step-generate-json.ts")},
 * which needs this — so leaving the implementation in the barrel makes the pair
 * an import cycle (Biome's `noImportCycles` catches it). Re-exported from
 * `utils.ts`, so `@alexkroman1/aai/utils` is still where a caller finds it.
 */

/**
 * Parse JSON, returning `undefined` on malformed input. JSON cannot encode
 * `undefined`, so the sentinel is unambiguous.
 *
 * @public
 */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON — fall through to the implicit undefined return.
  }
}
