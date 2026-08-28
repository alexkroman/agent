import { aaiAgentPlugin } from "@alexkroman1/aai/testing/vite";
import { defineConfig } from "vitest/config";

/**
 * Test config, deliberately separate from vite.config.ts.
 *
 * Vitest prefers this file, which is the point. `vite.config.ts` imports the
 * React and Tailwind plugins for the CLIENT build — neither has anything to
 * do with running an agent's tests, but loading them is a way for the test
 * run to fail. Measured in the studio: an agent's own test suite failed to
 * load because `defineConfig` came back undefined from an unresolved plugin
 * import, reported as `TypeError: default is not a function` with zero tests
 * collected. The agent then spent a build round "fixing" a test that was
 * fine.
 *
 * `globals: true` so `describe`/`test`/`expect` work with or without an
 * explicit `import { test } from "vitest"`. Both spellings are common, both
 * are correct, and tsconfig's `types: ["vitest/globals"]` already promises
 * the un-imported one — this makes the runtime match the types.
 *
 * `reporters` is PINNED, and left unset it is not merely a default — it is a
 * different reporter depending on who is running. Vitest 4 resolves an unset
 * value to `std-env`'s `isAgent ? "agent" : "default"`, and the agent reporter
 * prints a passing file's captured console output nowhere. So `aai test` run by
 * a coding agent — this project's own studio agent, or a CLI agent in your
 * terminal — swallowed every `console.log` from a test that passed, which is
 * exactly where you put one while working out what an agent said or which tool
 * it reached for. Measured on a scaffolded project, vitest 4.1.10: with the
 * agent markers in the environment a module-scope `console.warn` printed
 * nothing; with them stripped it printed; pinning this restored it either way.
 *
 * That reporter exists to keep an agent's output small, so this is a real
 * trade — it is pinned because a debugging line you cannot see costs more than
 * the tokens it saves, and because a test run that behaves differently
 * depending on who typed the command is the harder thing to reason about. Drop
 * the line if you would rather have the terser output.
 *
 * `aaiAgentPlugin` serves `virtual:aai/agent` — the agent lowered the way
 * `aai build` lowers it, so a spec imports one module instead of rebuilding it
 * out of a glob, a `?raw` read and `deployedAgent`.
 */
export default defineConfig({
  plugins: [aaiAgentPlugin()],
  test: {
    globals: true,
    reporters: ["default"],
  },
});
