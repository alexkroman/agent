// Copyright 2026 the AAI authors. MIT license.
/**
 * `isRecord` — the one record guard, in a module anything may import.
 *
 * It is published from `@alexkroman1/aai/utils` and was DEFINED there, which is
 * the problem this file exists to fix: `sdk/utils.ts` is a barrel as well as a
 * module, re-exporting thirteen others (`step-fetch.ts`, `step-generate.ts`,
 * `step-generate-json.ts`, `map-in-batches.ts`, …). So none of those thirteen
 * could import the guard without closing a cycle, and neither could anything
 * they import — `sdk/standard-schema.ts` says so in a comment and hand-rolls the
 * check instead. Nine open-coded guards across this package were the result,
 * each paying for the narrow a second time with a cast, which is exactly what
 * `guard-invariants` rule 17 exists to stop.
 *
 * The same move `safe-json-parse.ts` and `omit-undefined.ts` already document:
 * the definition lives in a leaf module, and `utils.ts` re-exports it so the
 * published import path is unchanged.
 *
 * @module is-record
 */

/**
 * Whether a value is a non-null, non-array object, narrowed to
 * `Record<string, unknown>` so its fields can be read without a second cast.
 *
 * The narrowing is the point. `typeof value === "object" && value !== null` is
 * three tokens anyone can write, which is exactly why it was written twelve
 * times here — and it narrows to `object`, on which every field read is an
 * error, so each site paid for it again with a cast
 * (`(value as { kind?: unknown }).kind`). A cast is not a check: it says
 * nothing about the value and stops reporting when the shape moves.
 *
 * Arrays are excluded because every caller is reading a NAMED field — `.type`,
 * `.error`, `.kind`, `.then` — none of which an array has. For "any non-null
 * object, arrays included", write the two comparisons inline; that case has one
 * site in this repo and does not want a name.
 *
 * @example
 * ```ts
 * import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
 *
 * function readStatus(body: string): string | undefined {
 *   const parsed = safeJsonParse(body);
 *   if (!isRecord(parsed)) return undefined;
 *   return typeof parsed.status === "string" ? parsed.status : undefined;
 * }
 * ```
 *
 * @public
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
