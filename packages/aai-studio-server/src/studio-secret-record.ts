// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading and writing a JSON RECORD in the {@link SecretStore}.
 *
 * Three records live there beside the raw values — the account's GitHub link
 * (`github-install:<uid>`), an approved `aai login` grant (`cli-link:<hash>`)
 * and a project's own secret record (`studio-project-env:<scope>:<project>`) —
 * and each had spelled the same five steps out for itself: `get`, null-check,
 * `safeJsonParse`, validate, fall back to a benign empty value. Three copies
 * of one posture, and the posture is security-relevant in all three: a
 * malformed record must read as ABSENT rather than throw, and must never be
 * cast into a shape nobody checked.
 *
 * The copies had already drifted in exactly that way. Two validated with a zod
 * schema; the third — the one deciding a deployed agent's env — used
 * `isRecord` plus `as Record<string, string>`, which narrows the container and
 * asserts the values without checking one of them.
 *
 * @module
 */

import { safeJsonParse } from "@alexkroman1/aai";
import type { SecretStore } from "aai-server/stores";
import type { z } from "zod";

/**
 * Validate one stored document. `null` for anything that does not parse or
 * does not match — the caller decides what absent MEANS.
 *
 * Split from {@link readJsonSecret} because one caller cannot use the combined
 * form: the `cli-link` exchange must DELETE the record before parsing it, so a
 * grant is spent exactly once even when its document is malformed.
 */
export function parseJsonSecret<T>(raw: string, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : null;
}

/** Read and validate a stored document; `null` when absent or malformed. */
export async function readJsonSecret<T>(
  secrets: SecretStore,
  name: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const raw = await secrets.get(name);
  return raw === null ? null : parseJsonSecret(raw, schema);
}

/** Record (or replace) a stored document. */
export async function writeJsonSecret(
  secrets: SecretStore,
  name: string,
  value: unknown,
): Promise<void> {
  await secrets.put(name, JSON.stringify(value));
}
