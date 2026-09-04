// Copyright 2026 the AAI authors. MIT license.
/**
 * One strict argv parse, because `process.argv.includes` CANNOT FAIL.
 *
 * Twenty-seven scripts under `scripts/` hand-rolled their flags, in three
 * spellings that all share the same defect: `process.argv.includes("--x")`, an
 * `indexOf` plus `argv[i + 1]`, and a `find` over `--name=value`. None of them
 * can tell a flag it does not know from a flag that is absent, so a typo is
 * indistinguishable from a default — and in this repo that is not a cosmetic
 * problem, because six gates decide whether to VERIFY or to WRITE THE TREE on
 * exactly that read:
 *
 *   sync-agent-guide.mjs        sync-scaffold-versions.mjs
 *   sync-guest-toolchain.mjs    sync-workflow-schema.mjs
 *   docs-markdown.mjs           api-report.mjs
 *
 * Each is `const CHECK = process.argv.includes("--check")` followed by
 * `if (!CHECK) { …write… }`. So `--chekc`, or `--check=1`, or a `pnpm` wrapper
 * that swallowed the argument, does not report an unknown flag: it rewrites the
 * committed copy the gate exists to compare against and exits 0. That is the
 * failure shape this repo keeps paying for — a gate whose success output is
 * indistinguishable from a gate that checked nothing — arriving by a new route.
 *
 * `node:util`'s `parseArgs` with `strict: true` makes an unknown or malformed
 * flag a hard error, which is the whole point. It is a BUILTIN: no dependency,
 * so no 48-hour `minimumReleaseAge` quarantine and nothing added to the
 * supply-chain surface for something Node already does.
 *
 * This module is the two things `parseArgs` leaves to the caller and every
 * caller would otherwise get subtly differently:
 *
 *   - **The error names the script and lists what it accepts.** `parseArgs`
 *     throws `ERR_PARSE_ARGS_UNKNOWN_OPTION`, whose message names the flag but
 *     not the program, and a raw throw prints a stack trace over a usage
 *     mistake. {@link parseScriptArgs} prints `<script>: <problem>` plus the
 *     accepted flags and exits 2 — distinct from 1, so a wrapper can tell
 *     "you invoked me wrong" from "the gate failed".
 *   - **A value flag must actually carry a value.** `--package` with nothing
 *     after it is what `indexOf` + `argv[i + 1]` answered `undefined` for, and
 *     the caller then treated as "no filter". `parseArgs` rejects the trailing
 *     case, and {@link requiredValue} covers the one it cannot see: an EMPTY
 *     string, which is what `--package "${{ matrix.package }}"` sends when a CI
 *     matrix variable does not expand. That step is the per-file coverage floor;
 *     an empty filter selected zero files and printed a checkmark.
 */

import { basename } from "node:path";
import { parseArgs } from "node:util";

/**
 * The exit code for a usage mistake.
 *
 * Deliberately not 1: every gate here exits 1 to mean "the thing I check is
 * broken", and a caller that cannot tell that apart from "I typed the flag
 * wrong" will read a misinvocation as a real finding. `check.mjs` relies on
 * this — see the note on `USAGE_EXIT` there.
 */
export const USAGE_EXIT = 2;

/**
 * `parseArgs`, strict, with a usage error that names the script.
 *
 * @param {object} spec
 * @param {string} spec.script `import.meta.url` of the calling script, so the
 *   error names the file a developer would go and read.
 * @param {import("node:util").ParseArgsOptionsConfig} spec.options
 *   `parseArgs` option config, verbatim — and named as node's own type rather
 *   than restated, which is what "verbatim" has to mean for the two to stay in
 *   step. The hand-written copy said `default?: unknown`, which node does not
 *   accept, so every caller's option object was rejected the moment a compiler
 *   looked at one.
 * @param {boolean} [spec.allowPositionals] Whether bare arguments are legal.
 *   Defaults to `false`, which is the safe direction: a script that does not
 *   expect positionals should reject `--chekc` rather than silently collect it.
 * @param {readonly string[]} [spec.argv] Override the arguments, for tests and
 *   for scripts that already thread an `argv` through their own `main`.
 * @returns {{ values: Record<string, any>, positionals: string[] }}
 */
export function parseScriptArgs({ script, options, allowPositionals = false, argv }) {
  const name = basename(script.startsWith("file:") ? new URL(script).pathname : script);
  try {
    return parseArgs({
      args: [...(argv ?? process.argv.slice(2))],
      options,
      allowPositionals,
      strict: true,
    });
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    console.error(`${name}: ${problem}`);
    console.error("\nAccepted flags:");
    for (const [flag, config] of Object.entries(options)) {
      const value = config.type === "string" ? " <value>" : "";
      console.error(`  --${flag}${value}`);
    }
    if (allowPositionals) console.error("  plus positional arguments");
    process.exit(USAGE_EXIT);
  }
}

/**
 * A string flag that must be present AND non-empty.
 *
 * `parseArgs` rejects `--package` with nothing after it, but `--package ""` is a
 * legal parse answering the empty string — and that is precisely what a shell
 * sends when an unexpanded variable is quoted. The one live instance is
 * `check.yml`'s coverage matrix step, where an empty package name selected no
 * files and the gate printed its success line over a measurement of nothing.
 *
 * @param {string | undefined} value
 * @param {string} flag Name without the leading dashes, for the message.
 * @param {string} script `import.meta.url` of the caller.
 * @returns {string}
 */
export function requiredValue(value, flag, script) {
  if (value !== undefined && value !== "") return value;
  const name = basename(script.startsWith("file:") ? new URL(script).pathname : script);
  console.error(
    value === undefined
      ? `${name}: --${flag} is required.`
      : `${name}: --${flag} was given an empty value. A shell sends this when a variable does not expand; it is never a valid selector.`,
  );
  process.exit(USAGE_EXIT);
}

/**
 * The `--name=value` reader the six loadtest harnesses each defined for
 * themselves.
 *
 * They are not gates, so the write-vs-verify hazard above does not apply — but
 * the helper stood six times in six files with two different bodies, which is
 * the same one-home argument the rest of this module makes: five accepted only
 * `--name=value` and silently ignored a bare `--name`, while `loadtest-probe`
 * and `loadtest-phone` read a bare flag as `true` (which is how `--speak`
 * works). This is the second behaviour, so the five widen: a bare `--name` now
 * answers `true` where it used to fall through to the default. That is the
 * right direction — a flag the user typed should not be discarded — and these
 * harnesses print their resolved settings on startup, so a `Number(true)` shows
 * up as a `1` in the banner rather than hiding.
 *
 * Kept separate from {@link parseScriptArgs} rather than folded in, because
 * these harnesses take an OPEN set of knobs read at their point of use; a strict
 * parse would mean maintaining a central option list for a throwaway benchmark
 * flag, which is a cost with no gate behind it.
 *
 * The reader is generic in its FALLBACK, so `arg("port", "4960")` is a string
 * rather than `unknown` and the harness's arithmetic and template literals need
 * no narrowing. `boolean` stays in the union on purpose: a bare `--port` really
 * does read as `true` (see above), and a signature that hid that would be the
 * one lie in this module.
 *
 * @param {readonly string[]} argv
 * The fallback is REQUIRED in the type though the body treats it as optional:
 * every one of the six readers supplies one, and `arg("typo")` answering
 * `undefined` is the shape of a benchmark that silently measures its defaults.
 *
 * @returns {<T>(name: string, fallback: T) => string | boolean | T}
 */
export function valueReader(argv) {
  return (name, fallback) => {
    const hit = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    if (hit === undefined) return fallback;
    // `indexOf`, not `split("=")`: a value may itself contain `=`, which every
    // copy of this helper got right by slicing and a `split` would truncate.
    const equals = hit.indexOf("=");
    return equals === -1 ? true : hit.slice(equals + 1);
  };
}

/**
 * The script's OWN flags, taken only from the front, with the rest forwarded
 * untouched.
 *
 * `dev-server.mjs` and `with-test-pg.mjs` are wrappers: they take a couple of
 * flags of their own and then a whole command to run
 * (`node scripts/with-test-pg.mjs pnpm test:scenario`). A strict
 * {@link parseScriptArgs} cannot serve them, because the forwarded command
 * carries flags this script has never heard of and must not interpret —
 * `pnpm --filter x dev` would be rejected on `--filter`.
 *
 * What they did instead was scan the WHOLE array — `args.includes("--print")`
 * plus `args.filter((a) => a !== "--print")` — which is wrong in the other
 * direction: a `--print` belonging to the FORWARDED command set the wrapper's
 * own mode and was then deleted from the command before it ran. Nothing in the
 * repo passes that today, so this is a latent bug rather than a live one, but it
 * is the kind that presents as "the flag I passed did nothing".
 *
 * Splitting at the first non-flag token is what a wrapper actually means: my
 * flags, then the command. Unknown LEADING flags are still an error, so a typo
 * in the wrapper's own flag is caught; anything after the command name is the
 * command's business. An explicit `--` also ends the flag section, for the case
 * where the forwarded program name would itself look like a flag.
 *
 * @param {object} spec
 * @param {string} spec.script `import.meta.url` of the calling script.
 * @param {Record<string, { type: "boolean" | "string" }>} spec.options
 * @param {readonly string[]} [spec.argv]
 * @returns {{ values: Record<string, any>, rest: string[] }}
 */
export function parseLeadingFlags({ script, options, argv }) {
  const args = [...(argv ?? process.argv.slice(2))];
  const own = [];
  while (args.length > 0) {
    const next = args[0];
    if (next === "--") {
      args.shift();
      break;
    }
    if (!next.startsWith("--")) break;
    own.push(args.shift());
    // A string-valued flag consumes the token after it, unless it was spelled
    // `--name=value`, in which case the value is already in hand.
    const name = own.at(-1).slice(2).split("=")[0];
    if (options[name]?.type === "string" && !own.at(-1).includes("=") && args.length > 0) {
      own.push(args.shift());
    }
  }
  const { values } = parseScriptArgs({ script, options, argv: own });
  return { values, rest: args };
}
