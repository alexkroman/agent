// Copyright 2026 the AAI authors. MIT license.
/**
 * The `aai login` device-link contract — the part BOTH ends must derive
 * identically.
 *
 * The terminal running `aai login` prints a confirmation code and the browser
 * approval gate shows the same one, so someone who lands on an approval page
 * they did not cause has a concrete mismatch to notice ("what terminal?")
 * instead of a bare Approve button. That only works while the two agree, and
 * they lived as verbatim copies in aai-cli and aai-studio-client, each
 * carrying a comment asking the next reader to keep them in lockstep — the
 * same arrangement `slug.ts` exists to have ended.
 *
 * Keep this module dependency-free: the CLI loads it on every invocation and
 * the studio client ships it to the browser.
 */

/**
 * Human-matchable confirmation derived from the link code.
 *
 * NOT a secret — both ends already hold the full code. It exists to be read
 * aloud off one screen and compared against the other.
 */
export function linkConfirmationCode(code: string): string {
  const head = code.slice(0, 8).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4)}`;
}
