// Copyright 2026 the AAI authors. MIT license.
/**
 * The port a guest binds, validated before anything can bind it.
 *
 * Extracted from `harness.ts`'s `main()`, which nothing can call in a test —
 * it installs crash guards, tees both process streams and binds a server — so
 * this validation was reachable only by spawning a real harness. It is the one
 * piece of `main()` that is a pure function of a string, and it decides a
 * failure mode worth a test rather than a comment.
 *
 * **An unparseable value must not reach `listen`.** `Number("eight")` is `NaN`
 * and `listen(NaN)` binds an EPHEMERAL port, so the guest comes up healthy on a
 * port nobody is dialling: the host waits out the tunnel dial and the spawn
 * fails blaming the network rather than the one env var that is wrong.
 *
 * @module
 */

/** The port used when the spawner names none. */
export const DEFAULT_GUEST_PORT = 8080;

/**
 * The port, or the OPERATOR-FACING reason it is not one.
 *
 * A string rather than a throw: the caller's answer to a bad port is to print
 * this and exit non-zero before binding, and an `Error` would only be unwrapped
 * to get back to the same sentence.
 */
export function resolveGuestPort(raw: string | undefined): number | string {
  if (raw === undefined) return DEFAULT_GUEST_PORT;
  // BLANK is refused rather than defaulted, and it is the sharpest case:
  // `Number("")` is 0, which is a legal port meaning "any free one", so the
  // original inline version bound an ephemeral port for an operator who had
  // written `AAI_GUEST_PORT=` and meant nothing by it — the very failure the
  // validation exists to prevent, reached through the one input that looks
  // like an omission.
  if (raw.trim() === "") return `Invalid AAI_GUEST_PORT "" — expected an integer port`;
  const port = Number(raw);
  // `0` is legal and means "any free port" — the subprocess backend uses it, so
  // the range check must not treat it as missing.
  return Number.isInteger(port) && port >= 0 && port <= 65_535
    ? port
    : `Invalid AAI_GUEST_PORT "${raw}" — expected an integer port`;
}
