import { base } from "./stryker.base.config.mjs";

/**
 * Mutation testing over the SCHEMA CORE, and nothing else.
 *
 * The one surviving scope. Six others existed — host, ui, studio, cli, server,
 * and a broad union in `stryker.config.mjs` — referenced by no gate, no CI job,
 * no turbo task and no guide, and unrunnable in practice: the host scope alone is
 * 29,376 source lines, i.e. thousands of mutants each running its covering tests
 * at `concurrency: 4` under a 60s timeout. This one is 689 lines and takes
 * minutes.
 *
 * **There is deliberately no `thresholds`/`break` here.** A threshold nothing
 * enforces reads as a gate, and this cannot be one — see `stryker.base.config.mjs`
 * for the `inPlace` hazard that rules it out. Mutation score is a DIAGNOSTIC you
 * run by hand (`pnpm test:mutate:sdk`) and read off the HTML report; the number to
 * compare against is the previous run's, not a committed floor.
 *
 * `check:test-assertions` is the cheap half and is not redundant with this: it
 * catches a test with NO assertion, where mutation catches an assertion that does
 * not DISCRIMINATE. Only the first is affordable per-PR.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  ...base,
  mutate: [
    "packages/aai/src/sdk/protocol.ts",
    "packages/aai/src/sdk/manifest.ts",
    "packages/aai/src/sdk/_internal-types.ts",
    "packages/aai/src/sdk/system-prompt.ts",
  ],
  htmlReporter: { fileName: "reports/mutation/sdk/index.html" },
  incrementalFile: ".stryker-incremental-sdk.json",
  timeoutMS: 30000,
};
