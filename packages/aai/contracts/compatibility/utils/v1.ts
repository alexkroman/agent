// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `utils` epoch 1.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  createKeyedLock,
  errorDetail,
  errorMessage,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  linkConfirmationCode,
  MAX_SLUG_LENGTH,
  normalizeSpeechText,
  omitUndefined,
  PREVIEW_SLUG_SUFFIX,
  pushCapped,
  RESERVED_SLUGS,
  safeJsonParse,
  VALID_SLUG_RE,
  withLock,
} from "../../../sdk/utils.ts";

/** Error narrowing, the two shapes a catch block needs. */
export function describe(error: unknown): { message: string; detail: string } {
  return { message: errorMessage(error), detail: errorDetail(error) };
}

/** An append-only list in `ctx.state` holds a cap, mutating in place. */
export function record(log: string[], line: string): string[] {
  return pushCapped(log, line, 50);
}

/** The one spelling of the optional half of an object literal. */
export function buildOptions(name?: string, greeting?: string): Record<string, unknown> {
  return { fixed: true, ...omitUndefined({ name, greeting }) };
}

/** Per-key serialization, with and without an acquire deadline. */
export const lock: KeyedLock = createKeyedLock();
export const lockOptions: KeyedLockOptions = { timeoutMs: 250 };

export async function serialized(sessionId: string): Promise<number> {
  return await withLock(lock, sessionId, async () => {
    await Promise.resolve();
    return lock.size;
  });
}

export async function bounded(sessionId: string): Promise<string> {
  const release = await lock(sessionId, lockOptions).catch((error: unknown) =>
    error instanceof KeyedLockTimeoutError ? error.key : undefined,
  );
  if (typeof release === "string") return release;
  release?.();
  return sessionId;
}

/** The slug contract both ends of a platform interaction derive identically. */
export function isDeployableSlug(slug: string): boolean {
  return (
    VALID_SLUG_RE.test(slug) &&
    slug.length <= MAX_SLUG_LENGTH &&
    !RESERVED_SLUGS.has(slug) &&
    !slug.endsWith(PREVIEW_SLUG_SUFFIX)
  );
}

export const confirmation: string = linkConfirmationCode("fixture-code");
export const spoken: string = normalizeSpeechText("Order #12 — ready?");
export const parsed: unknown = safeJsonParse('{"ok":true}');
