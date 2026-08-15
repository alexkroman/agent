// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 8.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative. Epoch 8 adds `isRecord` to epoch 7's surface and takes nothing
 * away, so this file only demonstrates what is new.
 *
 * The subject is the shape that forced the primitive: reading a field off a
 * body nobody has validated. `typeof value === "object" && value !== null` is
 * the check anyone writes, and it narrows to `object` — on which every field
 * read is an error, so each site paid for the check a second time with a cast.
 * The predicate returns `value is Record<string, unknown>`, so the cast goes
 * with it and the READ is what the compiler checks.
 */

import { isRecord, safeJsonParse } from "../../../sdk/utils.ts";

/** What one provider reply told us, with anything malformed left absent. */
export type JobStatus = { id: string | undefined; state: string | undefined; done: boolean };

/**
 * Read a job's status out of a body that has been through no schema.
 *
 * The nesting is the case worth pinning: `isRecord` narrows twice down the same
 * path, and neither step needs a shape asserted at it.
 */
export function readJobStatus(text: string): JobStatus {
  const body = safeJsonParse(text);
  if (!isRecord(body)) return { id: undefined, state: undefined, done: false };

  const job = isRecord(body.job) ? body.job : body;
  const id = typeof job.id === "string" ? job.id : undefined;
  const state = typeof job.state === "string" ? job.state : undefined;
  return { id, state, done: state === "completed" };
}

/**
 * A record of strings, dropping every entry that is not one.
 *
 * The other half of what the guard is for: an object whose VALUES are as
 * unchecked as the object was. Arrays are excluded by the predicate, which is
 * what makes `Object.entries` here mean what it reads as.
 */
export function readStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}
