// Copyright 2026 the AAI authors. MIT license.
/**
 * One-time codes a caller reads back — "the code on your screen is 4 8 1 9 0
 * 2" — minted, stored as a hash, and checked against what STT heard.
 *
 * Every app that linked a device or verified a phone wrote the same four
 * lines, and each line had a flaw a test does not see:
 *
 * - **The draw was biased.** `getRandomValues(new Uint32Array(1))[0] % 10 ** 6`
 *   makes the low codes likelier, because 2^32 is not a multiple of a million.
 *   Slightly, but a guessing budget is exactly what a bias spends.
 *   {@link mintDigitCode} draws each digit by rejection instead.
 * - **The hash was hand-rolled**, once per app, so two copies could disagree
 *   about hex case and the stored hash stop matching after a refactor.
 * - **The read-back was normalized with a private regex** — the one
 *   `spokenDigits` already is, so a read-back of "4819-02" and "4 8 1 9 0 2"
 *   compare the same.
 * - **The compare was `!==`**, which exits at the first differing character.
 *   {@link codeMatches} compares in constant time, with the compare the
 *   Standard Webhooks check uses.
 *
 * Web Crypto only (`crypto.getRandomValues`, `crypto.subtle`), so it runs in the
 * agent bundle, a guest and a browser alike — the `sdk/` rule, and the same
 * choice `standard-webhook.ts` makes.
 *
 * What is NOT here is the policy around a code: how long it lives, how many
 * tries it allows, where the hash is stored. Those belong to the app that
 * issues it; a code with no attempt cap is guessable whatever its draw.
 *
 * @module
 */

import { timingSafeEqual } from "./_timing-safe-equal.ts";
import { spokenDigits } from "./spoken.ts";

/** Longest code {@link mintDigitCode} draws — far past anything read aloud. */
const MAX_DIGITS = 32;

/**
 * Bytes at or above this are re-drawn: 250 is the largest multiple of 10 a byte
 * holds, so `byte % 10` over `[0, 250)` is uniform.
 */
const BYTE_LIMIT = 250;

/**
 * A `digits`-long code of decimal digits, drawn from the platform's
 * cryptographic randomness with no modulo bias — `"048190"`, leading zeros
 * kept, because the code is a STRING a caller reads, not a number.
 *
 * Deliberately takes no `random` source, unlike `mintCode`: a code that proves
 * who is on the line must not be a journaled, replayable value. Mint it inside
 * a tool body or a `ctx.step` and store {@link hashCode}'s output, never the
 * code.
 *
 * @param digits - How many digits. Default 6. An integer from 1 to 32.
 * @throws RangeError if `digits` is not an integer in that range.
 *
 * @example
 * ```ts
 * import { hashCode, mintDigitCode } from "@alexkroman1/aai";
 *
 * const code = mintDigitCode(); // e.g. "048190"
 * const stored = await hashCode(code); // keep this, say `code`
 * ```
 *
 * @public
 */
export function mintDigitCode(digits = 6): string {
  if (!Number.isInteger(digits) || digits < 1 || digits > MAX_DIGITS) {
    throw new RangeError(`mintDigitCode: digits must be an integer from 1 to ${MAX_DIGITS}`);
  }
  let code = "";
  // A batch per round; rejection drops ~2% of bytes, so one round almost always suffices.
  while (code.length < digits) {
    for (const byte of crypto.getRandomValues(new Uint8Array(digits * 2))) {
      if (byte >= BYTE_LIMIT) continue;
      code += String(byte % 10);
      if (code.length === digits) break;
    }
  }
  return code;
}

/**
 * The SHA-256 of `code`, as lower-case hex — what to STORE for a one-time code
 * instead of the code itself.
 *
 * Hashes exactly the string given. It does not normalize, because the one
 * string it is handed at mint time is already the canonical code; a READ-BACK
 * goes through {@link codeMatches}, which normalizes before it hashes. Hashing
 * a read-back here by hand means normalizing it first (`spokenDigits`).
 *
 * A six-digit code's hash is brute-forced in a millisecond by anyone holding
 * it, so the hash keeps the code out of logs and backups, not out of a
 * determined attacker with the table: the attempt cap and the expiry are the
 * defence.
 *
 * @public
 */
export async function hashCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Whether what a caller SAID is the code whose {@link hashCode} is `hash`.
 *
 * `said` is normalized with `spokenDigits` — everything but digits dropped — so
 * STT's `"4819 02"`, `"4819-02"` and `"it's 4 8 1 9 0 2"` all match `"481902"`.
 * The hashes are compared in constant time, and hex case is ignored. A
 * read-back with no digits at all never matches.
 *
 * @example
 * ```ts
 * import { codeMatches } from "@alexkroman1/aai";
 *
 * declare const stored: { codeHash: string; attempts: number };
 *
 * export async function verify(said: string): Promise<boolean> {
 *   if (stored.attempts >= 5) return false; // the cap is the app's
 *   stored.attempts++;
 *   return await codeMatches(said, stored.codeHash);
 * }
 * ```
 *
 * @public
 */
export async function codeMatches(said: string, hash: string): Promise<boolean> {
  const digits = spokenDigits(said);
  if (digits === "") return false;
  return timingSafeEqual(await hashCode(digits), hash.toLowerCase());
}
