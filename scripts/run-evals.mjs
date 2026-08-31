// Copyright 2026 the AAI authors. MIT license.
/**
 * Run the eval tiers against a LIVE model.
 *
 * ## Why this exists
 *
 * `turbo run check:eval` was the only way to run every eval, and on a developer
 * machine it quietly ran none of them. The template evals resolve their
 * credential with `resolveEvalMode`, which reads the ENVIRONMENT and nothing
 * else — correct for a published library, which has no business reading
 * `~/.config/aai/config.json` — so a developer who had run `aai login` got all
 * 25 template evals on the SCRIPTED model and a summary that says
 * `25 passed (25)`. Measured: 70 passed, 20 skipped, zero live model calls, and
 * the only sign was one `SCRIPTED model` line per template scrolling past above
 * the green total.
 *
 * That is the repo's standing failure shape — a green run of nothing being
 * indistinguishable from a green run of something — and `aai-evals/_gate.ts`
 * already solves it for its own tier by falling back to the saved key. This
 * script is that fallback for the whole tier, in the one place that may have it:
 * a repo script, which spends the RUNNER's key by definition.
 *
 * ## What it does
 *
 * Resolves the key exactly as every other developer tool here does (exported
 * `ASSEMBLYAI_API_KEY` wins, else what `aai login` saved), hands it to the child,
 * and sets `AAI_REQUIRE_EVAL=1` so a case that would SKIP or fall back to the
 * scripted model fails loudly instead. If you asked for a live run, a scripted
 * one is a failure and not a result.
 *
 * ```sh
 * pnpm test:eval                        # every eval, live
 * pnpm test:eval:templates              # the 25 template evals, live
 * pnpm test:eval:templates --allow-scripted   # let a template without its
 *                                             # provider key degrade instead
 * pnpm test:eval --stub                 # scripted, which is what CI gates on
 * ```
 *
 * One template needs a credential this script does not resolve:
 * `templates/pipeline-simple` names an Anthropic LLM stage, so a live run of it
 * wants `ANTHROPIC_API_KEY` too. Without that key the default fails it by
 * design; `--allow-scripted` is the way to run the other 24 live anyway.
 *
 * `--stub` is the escape hatch, and it does NOT resolve a key: it sets
 * `AAI_EVAL_STUB=1` and drops `AAI_REQUIRE_EVAL`, which is the wiring check
 * `scripts/check.mjs` and `check.yml` run. Those two call
 * `turbo run check:eval` directly and do not come through here, so nothing in
 * the merge path depends on this file.
 */

import { spawn } from "node:child_process";
import { apiKey } from "./_api-key.mjs";
import { parseScriptArgs } from "./_args.mjs";

const { values } = parseScriptArgs({
  script: import.meta.url,
  options: {
    filter: { type: "string" },
    stub: { type: "boolean", default: false },
    "allow-scripted": { type: "boolean", default: false },
    only: { type: "string" },
    repeat: { type: "string" },
  },
});

/**
 * The child's environment.
 *
 * Every name here is declared in `check:eval`'s `env` in `turbo.json`, and it
 * has to be: turbo runs tasks in strict env mode, where an undeclared variable
 * is stripped SILENTLY — so a key resolved here and not declared there would
 * produce exactly the scripted-model run this script exists to prevent.
 */
function childEnv() {
  if (values.stub) return { AAI_EVAL_STUB: "1" };
  let key;
  try {
    key = apiKey();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`run-evals: no AssemblyAI key (${why}).`);
    console.error("Export ASSEMBLYAI_API_KEY, or run `aai login`.");
    console.error("To run the wiring check against a scripted model instead: --stub");
    process.exit(1);
  }
  /** @type {Record<string, string>} */
  const env = { ASSEMBLYAI_API_KEY: key };
  // A skip or a scripted fallback is a FAILURE by default — the caller asked for
  // a live run, and the whole point of this script is that they got one.
  //
  // `--allow-scripted` is for the MIXED case, which is real: a template whose
  // pipeline names another provider needs that provider's key to run live, and
  // `templates/pipeline-simple` needs `ANTHROPIC_API_KEY`. Without the flag that
  // template fails the run on a machine holding only an AssemblyAI key —
  // correctly, and uselessly, every time. With it, the other 24 still run live
  // and that one degrades with its reason printed.
  if (!values["allow-scripted"]) env.AAI_REQUIRE_EVAL = "1";
  // Plain assignment rather than a conditional spread: `guard-invariants` rule 2
  // bans the `=== undefined` spread and points at `omitUndefined()`, which is an
  // `@alexkroman1/aai` export a repo script has no business importing.
  if (values.only !== undefined) env.AAI_EVAL_ONLY = values.only;
  if (values.repeat !== undefined) env.AAI_EVAL_REPEAT = values.repeat;
  return env;
}

const env = childEnv();
const args = ["exec", "turbo", "run", "check:eval", "--concurrency=1"];
if (values.filter !== undefined) args.push("--filter", values.filter);

console.error(
  values.stub
    ? "run-evals: SCRIPTED model (--stub) — this checks wiring, not behaviour."
    : "run-evals: LIVE model. This spends tokens on the resolved key.",
);

const child = spawn("pnpm", args, {
  stdio: "inherit",
  env: { ...process.env, ...env },
});
// Sync listeners: an `async` function handed to `.on` is `guard-invariants`
// rule 23, and there is nothing to await here.
child.on("error", (err) => {
  console.error(`run-evals: ${err.message}`);
  process.exit(1);
});
// `null` is a child killed by a signal, which is a failure and not a pass.
child.on("close", (code) => process.exit(code ?? 1));
