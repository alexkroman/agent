// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolving your project's own FILES in a spec, the way a build does — the
 * `tools/` directory and `system-prompt.md`.
 *
 * **Under vitest a spec calls none of this.** `aaiAgentPlugin()`
 * (`@alexkroman1/aai/testing/vite`, registered in a scaffolded project's
 * `vitest.config.ts`) serves the whole lowering as one module, resolved against
 * the importing spec's own directory:
 *
 * ```ts
 * import agentDef from "virtual:aai/agent";
 * ```
 *
 * {@link deployedAgent} is that same lowering written out, for a runner that is
 * not vitest and so cannot register the plugin. It applies BOTH halves in one
 * call because forgetting one of them is silent and produces a green suite
 * measuring the framework defaults; its own doc carries that argument. There is
 * no exported tools-only half — that was `withDiscoveredTools`, now internal.
 *
 * A tool is registered by EXISTING: `tools/add_item.ts` is the tool
 * `add_item`, and nothing lists them anywhere. That enumeration happens where
 * the bundle is assembled — a deployed agent is handed one ESM string and has no
 * directory to scan — so `agent.ts`'s own default export carries only the tools
 * it declared INLINE, and `def.tools` in a spec is empty (or short) for every
 * project whose tools are files.
 *
 * A spec has no bundler in its path, so the lowering has to happen somewhere —
 * in the plugin, or in a {@link deployedAgent} call the spec writes.
 *
 * **The glob has to be written at the call site, and that is why
 * {@link ProjectFiles} takes the RESULT rather than a directory.**
 * `import.meta.glob` is expanded at TRANSFORM time against the file that
 * contains it, so a pattern inside this module would resolve against the SDK's
 * own directory and find nothing. It also cannot take a variable, which is why
 * there is no `deployedAgent(def, { tools: "./tools" })`.
 *
 * **And it is deliberately not a `readdir` + `import()`.** That would resolve
 * the tool modules through NODE rather than through your test runner, handing
 * them a second copy of `@alexkroman1/aai` — so a `sessionSlot`'s module-level
 * state would differ between the tool under test and the agent holding it,
 * which is the "two physically distinct copies of React" bug wearing a
 * different hat. `import.meta.glob` keeps every module in one graph.
 */

import { withSystemPrompt } from "./system-prompt-file.ts";
import type { ToolBearingAgent } from "./testing-tools.ts";
import { type ToolModules, toolRegistry, withTools } from "./tool-registry.ts";
import type { AgentDef } from "./types.ts";

/**
 * The tools half of {@link deployedAgent}: the def `agent.ts` exports, plus the
 * tools its `tools/` directory declares.
 *
 * **Not exported, and not to be re-exported.** It was on
 * `@alexkroman1/aai/testing` and came off when `virtual:aai/agent` started
 * serving the whole lowering — a spec that lowers the tools and forgets the
 * system prompt measures the framework default prompt and reports green, which
 * is the failure {@link deployedAgent} exists to make unrepresentable. That
 * function is its only caller; a spec reaches the lowering through the plugin or
 * through it.
 *
 * `modules` is the RESULT of `import.meta.glob("./tools/*.ts", { eager: true })`
 * — see the module doc for why the glob belongs at the call site. Every rule the
 * build applies applies here too, and each is an error naming the file: the name
 * grammar, the default-export requirement, no nested files, and a name declared
 * twice.
 *
 * Structural rather than `AgentDef`, the same as {@link toolOf} and
 * {@link runTool} next door, and it hands back the def it was given — so the
 * caller keeps the type it passed in.
 *
 * @internal
 */
export function withDiscoveredTools<D extends ToolBearingAgent>(def: D, modules: ToolModules): D {
  return withTools(def, toolRegistry(modules));
}

/**
 * What the BUILD lowers onto an `agent.ts` default export — the files beside it
 * that a deployed agent runs with and a spec has to apply itself.
 *
 * Both fields are optional and at least one must be present: an empty object is
 * a call that does nothing, which is the shape of a forgotten argument rather
 * than of a project with no files.
 */
export type ProjectFiles = {
  /**
   * `import.meta.glob("./tools/*.ts", { eager: true })`, written at the CALL
   * SITE — see the module doc for why it cannot be a directory string.
   *
   * Omit it for a project with no `tools/` directory. Passing an EMPTY glob is
   * an error, not a no-op: see {@link deployedAgent}.
   */
  readonly tools?: ToolModules;
  /**
   * `import prompt from "./system-prompt.md?raw"`.
   *
   * Omit it for a project with no `system-prompt.md`. Pass it even when
   * `agent.ts` imports the file itself and composes it — that case is
   * recognised and the def is left exactly as the author built it, so a spec
   * never has to know which of the two its own template does.
   */
  readonly systemPrompt?: string;
};

/**
 * The def a DEPLOYED agent runs: the one `agent.ts` exports, plus the tools its
 * `tools/` directory declares, plus what its `system-prompt.md` says.
 *
 * **This is one call because forgetting HALF of it is the failure it exists to
 * prevent, and that failure is silent.** Neither lowering is applied by
 * `agent()` — both are applied by the BUILD (`aai build` enumerates `tools/`
 * and resolves the prompt file) — so a spec or an eval driving the raw default
 * export measures an agent with NO TOOLS and the FRAMEWORK-DEFAULT system
 * prompt. Nothing fails: the model answers plausibly out of its own knowledge,
 * every case that asserts a sentence still passes, and the suite reports green
 * on a different agent than the one anybody deploys. It produced four bogus
 * green eval results in one day, and the two nested wrappers it replaces — a
 * tools lowering inside a prompt lowering, written out in seventeen template
 * evals — are exactly the shape where one of the two goes missing under an edit.
 *
 * **Under vitest, prefer `import agentDef from "virtual:aai/agent"`**, which is
 * this call made for you against the importing spec's own directory (see the
 * module doc). Reach for this one when the runner is not vitest, or when the
 * lowering itself is the subject of the spec.
 *
 * **An EMPTY `tools` glob throws.** That is the same bug wearing its other
 * face: `import.meta.glob("./tool/*.ts")` (or a `tools/` directory that moved)
 * matches nothing, and lowering nothing onto the def is indistinguishable from
 * not lowering at all. A project with no tools omits the field instead, which
 * is a statement rather than an accident.
 *
 * ```ts no-check
 * // `no-check`: two of these imports are files YOU own — `./agent.ts` and
 * // `./system-prompt.md?raw` — which exist in your project and in no tree of
 * // ours, so nothing here can resolve them. (`import.meta.glob` is not the
 * // blocker: the doc-example gate compiles against the scaffold's own
 * // `global.d.ts`, which carries `/// <reference types="vite/client" />`.)
 * import { deployedAgent } from "@alexkroman1/aai/testing";
 * import authored from "./agent.ts";
 * import systemPrompt from "./system-prompt.md?raw";
 *
 * const agentDef = deployedAgent(authored, {
 *   tools: import.meta.glob("./tools/*.ts", { eager: true }),
 *   systemPrompt,
 * });
 * ```
 *
 * Every rule the build applies applies here too, and each is an error naming
 * the file: the tool-name grammar, the default-export requirement, no nested
 * files, a name declared twice, an empty prompt file, and a
 * `system-prompt.md` that exists while `agent.ts` declares a DIFFERENT prompt —
 * the "I edited the prompt and nothing changed" failure.
 *
 * @public
 */
export function deployedAgent<D extends AgentDef>(authored: D, project: ProjectFiles): D {
  const { tools, systemPrompt } = project;
  if (tools === undefined && systemPrompt === undefined) {
    throw new Error(
      'deployedAgent was given no project files. Pass `tools: import.meta.glob("./tools/*.ts", { eager: true })` for a project whose tools are files, `systemPrompt` for one with a system-prompt.md, or both — an empty second argument lowers nothing and leaves the eval measuring the framework defaults.',
    );
  }
  if (tools !== undefined && Object.keys(tools).length === 0) {
    throw new Error(
      'deployedAgent was given an EMPTY tools glob, which lowers nothing. Check the pattern (it must be a literal, expanded against THIS file — `import.meta.glob("./tools/*.ts", { eager: true })`), or omit `tools` if this project really has no tools/ directory.',
    );
  }
  const lowered = tools === undefined ? authored : withDiscoveredTools(authored, tools);
  return systemPrompt === undefined ? lowered : withSystemPrompt(lowered, systemPrompt);
}
