// Copyright 2026 the AAI authors. MIT license.
/**
 * The ONE measure of an agent env record against `MAX_ENV_SIZE`.
 *
 * The bundle store's `writeEnv` is the last line (nothing over the cap reaches
 * the SecretStore), but a caller that writes SEVERAL records for one request —
 * the studio's project secrets write the project record and then each agent's
 * env — has to know before the first write that the last one will fit, or a
 * refusal halfway leaves the earlier writes behind. Both sides call
 * {@link envSize}, so the pre-check and the store cannot disagree about what
 * fits.
 *
 * Measured in UTF-8 bytes of the serialized record, which is what the limit's
 * name and its error message say (a `string.length` counted UTF-16 code units).
 */

import { MAX_ENV_SIZE } from "./constants.ts";

/** Bytes `env` occupies once serialized the way the SecretStore holds it. */
export function envSize(env: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify(env));
}

/**
 * An env record over `MAX_ENV_SIZE`. A statement about the CALLER's request —
 * well-formed and too big — so `createErrorHandler` answers it with 413.
 *
 * The message names the record and the byte counts, NEVER a value: these are
 * secrets, and the message reaches the caller and the log.
 */
export class EnvTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;
  constructor(subject: string, size: number, limit: number = MAX_ENV_SIZE) {
    super(`${subject} would be ${size} bytes, over the ${limit}-byte limit for secrets`);
    this.name = new.target.name;
    this.size = size;
    this.limit = limit;
  }
}

/**
 * Throw {@link EnvTooLargeError} unless `env` fits.
 *
 * @param subject what the record is, for the message (`"Secrets for agent x"`).
 */
export function assertEnvFits(env: Record<string, string>, subject: string): void {
  const size = envSize(env);
  if (size > MAX_ENV_SIZE) throw new EnvTooLargeError(subject, size);
}
