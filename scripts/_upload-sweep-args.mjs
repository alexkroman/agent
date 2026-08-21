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
const STRINGS = ["target", "token", "mib", "concurrency", "part-mib", "repeat", "gap-ms", "json"];
const FLAGS = ["h2", "no-shuffle", "no-warmup", "no-single", "yes"];

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
 */
export function parseSweepArgs() {
  try {
    return parseArgs({ options: OPTIONS, strict: true }).values;
  } catch (err) {
    console.error(`upload-sweep: ${err.message}`);
    usage();
    process.exit(2);
  }
}
