// Copyright 2026 the AAI authors. MIT license.
/**
 * The two run-shaping settings `describeEval` reads, and how it reads them.
 *
 * ## Why this exists
 *
 * `AAI_EVAL_REPEAT` and `AAI_EVAL_ONLY` were declared in `check:eval`'s `env` in
 * `turbo.json`, forwarded by `scripts/run-evals.mjs` as `--repeat` and `--only`,
 * documented in that script's header — and read by NOTHING on this side. Only
 * `aai-evals` honoured them, so for all twenty-eight template suites both flags
 * were a silent no-op: `pnpm test:eval:templates --repeat 3` set the variable,
 * turbo passed it through strict env mode, and every case ran exactly once.
 *
 * Measured before this module existed: `AAI_EVAL_REPEAT=3` on a two-case suite
 * ran two tests, not six, and `AAI_EVAL_ONLY=nonexistent-case-xyz` ran both
 * cases instead of none.
 *
 * That is the same failure shape `run-evals.mjs` was written to prevent — its
 * header is about a green run of nothing being indistinguishable from a green
 * run of something — one level down: a run of ONE is indistinguishable from a
 * run of THREE. And it lands on exactly the instrument this tier needs most,
 * because a live model is a noisy one and `--repeat` is how a defect is told
 * apart from variance. Without it that judgement is made by running the whole
 * suite by hand several times and diffing which cases moved.
 *
 * ## The duplication, on purpose
 *
 * `packages/aai-evals/src/env.ts` is the sibling of this file and says the same
 * things about blank-counts-as-unset. It is not imported here and cannot be:
 * `aai-runtime` may import only `aai`, and `aai-evals` sits ABOVE this package
 * rather than beside it. Converging them means publishing this policy on the
 * `/eval` barrel, which is a public API change with an api-report and a
 * capability epoch attached — worth doing, and deliberately not done in the
 * change that made the flags work at all.
 *
 * What must not drift is the BLANK rule, which both files carry for the same
 * reason: `AAI_EVAL_REPEAT= pnpm test:eval` is how a shell unsets a variable for
 * one command, so a blank value has to read as absent rather than as `NaN`.
 *
 * @module
 */

/**
 * An env var's value, or undefined when it is unset OR blank.
 *
 * See the module doc: blank is how a shell unsets one for a single command.
 */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/**
 * How many times each selected case runs. Defaults to 1, which is the shape
 * every existing run has — this setting is opt-in and changes nothing unset.
 *
 * THROWS on a value that is present and unusable rather than coercing it, which
 * is `aai-evals`' rule and is right for the same reason: `Number("three")` is
 * `NaN`, `NaN` repeats read as zero repeats, and a suite that silently ran
 * nothing is the outcome this whole tier is built to make impossible.
 */
export function evalRepeat(env: Record<string, string | undefined> = process.env): number {
  const raw = envValue(env, "AAI_EVAL_REPEAT");
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`AAI_EVAL_REPEAT must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Does `AAI_EVAL_ONLY` select a case by this name?
 *
 * A substring match, case-insensitively, which is `evalOnlySelects`' rule one
 * package up — and the same reason applies: the caller is a developer typing
 * part of a case name, not a glob.
 *
 * Unset selects EVERYTHING, so the default run is untouched.
 */
export function evalOnlySelects(
  name: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const only = envValue(env, "AAI_EVAL_ONLY");
  return only === undefined || name.toLowerCase().includes(only.toLowerCase());
}
