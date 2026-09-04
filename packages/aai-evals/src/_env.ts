// Copyright 2026 the AAI authors. MIT license.
/**
 * How this tier reads an environment variable — the vocabulary, not the policy.
 *
 * `runner.ts` used to declare {@link envValue} privately, with a doc that said
 * "a rule spelled out twice is one that can come to be spelled differently".
 * It was spelled FIVE times: `resolveKey` tested `!== undefined && trim() !==
 * ""`, `announceOrThrow` tested `(x ?? "") !== ""` with no trim, `evalContracts`
 * tested `!== "" && !== "0"` with no trim, `evalOnly` was a byte-for-byte copy,
 * and `AAI_STEP_CAP_HINT` was read with a bare `Number(process.env.X ?? 80)` in
 * an eval file — so a blank one yielded `NaN` and every step-cap check failed.
 * The function warning about the drift is the one that got drifted around.
 *
 * Its own module rather than an export of `runner.ts`, because `_gate.ts` is the
 * other caller and it cannot be the home: that module resolves a key, imports
 * `vitest` and ANNOUNCES at import time, all of which `runner.ts` must not pull
 * in. That side effect is also why a NAMED setting a unit-tested module needs
 * lands here rather than beside `evalOrigin` — see {@link evalStepCapHint}. The
 * POLICY stays in `_gate.ts`: which precondition a tier has, what a missing one
 * means, and when a skip becomes a failure.
 *
 * @module
 */

/**
 * An env var's value, or undefined when it is unset OR blank.
 *
 * Blank counts as unset everywhere, which matters because `AAI_EVAL_REPEAT=
 * pnpm test:eval` is how a shell unsets one for a single command.
 */
export function envValue(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const raw = env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/**
 * An opt-in flag: set and not blank, and not the one word that means off.
 *
 * `"0"` reads as off so `AAI_EVAL_CONTRACTS=0` can turn the contract half off
 * without unsetting it, which is what a CI matrix row wants.
 */
export function envFlag(env: Record<string, string | undefined>, name: string): boolean {
  const raw = envValue(env, name);
  return raw !== undefined && raw !== "0";
}

/**
 * A positive integer setting, or `fallback` when it is unset or blank.
 *
 * THROWS on a value that is present and unusable rather than coercing it: the
 * alternative is `Number("eighty") === NaN`, and every comparison against a
 * `NaN` bound silently answers false — which reads as the agent failing the
 * check rather than as the setting being wrong.
 */
export function envInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = envValue(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Roughly the studio's `MAX_CHAT_STEPS`; only used to flag a long run.
 *
 * Here rather than beside `evalOrigin` in `_gate.ts`, which is where the tier's
 * other configuration lives, and the reason is mechanical: importing that module
 * RESOLVES a key and announces — or, under `AAI_REQUIRE_EVAL`, THROWS — at
 * import time. `starter-grade.ts` reads this and is unit-tested, so a settings
 * import that drags the gate in fails the whole unit file on any machine with
 * `AAI_REQUIRE_EVAL` set and no key. Verified before moving it: it did.
 *
 * It was `Number(process.env.AAI_STEP_CAP_HINT ?? 80)` in an eval file, which
 * turns a blank value into `NaN` — and every `<` against a `NaN` bound answers
 * false, i.e. the step-cap check fails and reads as the agent having run away.
 */
export function evalStepCapHint(env: Record<string, string | undefined> = process.env): number {
  return envInt(env, "AAI_STEP_CAP_HINT", 80);
}
