// Copyright 2026 the AAI authors. MIT license.

/**
 * The option vocabulary for `upload-sweep.mjs`, and the parse behind it.
 *
 * Its own module for the reason `_upload-sweep-report.mjs` is: the sweep body
 * is the measurement, and this is the argument surface around it.
 */

import { parseArgs } from "node:util";

/**
 * Every option the sweep accepts, by kind.
 *
 * DECLARED rather than inferred from argv, which the hand-rolled loop this
 * replaced did twice over: it read only the space-separated form, so every
 * `--concurrency=1,2,4` in the sweep's own examples parsed as a valueless FLAG
 * and the run silently used the default matrix; and it inferred "flag" from "no
 * value follows", so a `--mib` whose argument the shell ate measured 32 MiB
 * instead. Both produce a sweep that answers a question nobody asked, with
 * nothing in the output saying so. `strict` refuses them and a misspelled flag.
 */
// `@type {const}` (JSDoc's `as const`) so the parsed shape below can be DERIVED
// from these two lists rather than restated beside them — a hand-written twin
// of a name list is the thing that falls behind it.
const STRINGS = /** @type {const} */ ([
  "target",
  "token",
  "mib",
  "concurrency",
  "part-mib",
  "repeat",
  "gap-ms",
  "json",
]);
const FLAGS = /** @type {const} */ (["h2", "no-shuffle", "no-warmup", "no-single", "yes"]);

/**
 * What `parseSweepArgs` hands back: every string option optional, every flag
 * present (they carry `default: false`).
 *
 * Worth declaring rather than leaving as `parseArgs`'s index signature, which
 * resolves ANY key: `args.targt` read as `undefined`, so the sweep would print
 * "--target is required" for a flag that was right there in argv.
 *
 * @typedef {{ [K in (typeof STRINGS)[number]]?: string } & { [K in (typeof FLAGS)[number]]: boolean }} SweepArgs
 */

/** @type {import("node:util").ParseArgsOptionsConfig} */
export const OPTIONS = Object.fromEntries([
  ...STRINGS.map((name) => [name, { type: "string" }]),
  ...FLAGS.map((name) => [name, { type: "boolean", default: false }]),
]);

export function usage() {
  console.error("usage: node scripts/upload-sweep.mjs --target <agent base url> [options]");
  console.error("       see scripts/upload-sweep.mjs's doc comment for the whole vocabulary");
}

/**
 * Parse argv, or print the reason and exit 2.
 *
 * A person runs the sweep, so a refusal is the message plus the usage line —
 * not a `parseArgs` stack trace through `node:internal`.
 *
 * @returns {SweepArgs}
 */
export function parseSweepArgs() {
  try {
    // `OPTIONS` is built with `Object.fromEntries`, so its per-flag kinds are
    // not recoverable from its type — this is where the shape those two lists
    // describe is claimed. See `SweepArgs`.
    return /** @type {SweepArgs} */ (parseArgs({ options: OPTIONS, strict: true }).values);
  } catch (err) {
    console.error(`upload-sweep: ${err.message}`);
    usage();
    process.exit(2);
  }
}
