// Copyright 2026 the AAI authors. MIT license.
/**
 * The three eval settings that name the STUDIO, rather than the eval tier.
 *
 * `aai-evals` is the tier's framework — the recording runner, the spread report,
 * the assertion vocabulary and the key gate — and it is framework-GENERAL by
 * construction now that a second package drives it. These three are the
 * counter-example that made the line easy to draw: every one of them configures
 * the target in this package and nothing else. `AAI_EVAL_ORIGIN` is the HTTP
 * origin `studio-eval-target.ts` dials, `AAI_EVAL_CONTRACTS` turns
 * `studio-template-contract.ts` on, and `AAI_STEP_CAP_HINT` is the studio's own
 * `MAX_CHAT_STEPS`. They lived in the tier's `_gate.ts`/`_env.ts` while the
 * starter eval did, and moved with it.
 *
 * They read the environment through `aai-evals/env`, not through a local copy of
 * "blank counts as unset". That rule was spelled FIVE different ways before it
 * was one function, and two of the five were `evalContracts` and the step-cap
 * hint — so re-deriving either here is the exact regression the shared module
 * exists to prevent.
 *
 * Every name here is declared in `check:eval`'s `env` in `turbo.json`; strict
 * env mode strips an undeclared variable SILENTLY, which would leave a run
 * reading the default with the variable exported right there in the shell.
 *
 * @module
 */

import { envFlag, envInt } from "aai-evals/env";

/** The studio origin the starter eval drives. */
export function evalOrigin(env: Record<string, string | undefined> = process.env): string {
  return env.AAI_EVAL_ORIGIN ?? "http://127.0.0.1:8080";
}

/**
 * Is the template behaviour contract on?
 *
 * OFF by default, and the default is the point: a contract run is a live model
 * session on top of a codegen turn that already takes minutes, so turning it on
 * for everyone would roughly double the tier's cost and wall clock to answer a
 * question most runs are not asking. `AAI_EVAL_CONTRACTS=1` opts in — see
 * `studio-template-contract.ts` for what it then grades.
 */
export function evalContracts(env: Record<string, string | undefined> = process.env): boolean {
  return envFlag(env, "AAI_EVAL_CONTRACTS");
}

/**
 * Roughly the studio's `MAX_CHAT_STEPS`; only used to flag a long run.
 *
 * It sat in the tier's `_env.ts` rather than beside `evalOrigin` in its
 * `_gate.ts`, and the reason was mechanical: importing the gate RESOLVES a key
 * and announces — or, under `AAI_REQUIRE_EVAL`, THROWS — at import time, while
 * `studio-starter-grade.ts` reads this and is unit-tested, so a settings import
 * that dragged the gate in failed the whole unit file on any machine with
 * `AAI_REQUIRE_EVAL` set and no key. Verified before that move: it did.
 *
 * The hazard is gone rather than merely avoided now — this module imports
 * `aai-evals/env`, which has no import-time side effect at all, and `evalOrigin`
 * is beside it because the gate is no longer where it lives. Keep it that way:
 * a setting a unit-tested module reads may not come from `aai-evals/gate`.
 *
 * It was `Number(process.env.AAI_STEP_CAP_HINT ?? 80)` in an eval file, which
 * turns a blank value into `NaN` — and every `<` against a `NaN` bound answers
 * false, i.e. the step-cap check fails and reads as the agent having run away.
 */
export function evalStepCapHint(env: Record<string, string | undefined> = process.env): number {
  return envInt(env, "AAI_STEP_CAP_HINT", 80);
}
