// Copyright 2026 the AAI authors. MIT license.
/**
 * Resolving your project's `tools/` directory in a SPEC, the way a build does.
 *
 * A tool is registered by EXISTING: `tools/add_item.ts` is the tool
 * `add_item`, and nothing lists them anywhere. That enumeration happens where
 * the bundle is assembled — a deployed agent is handed one ESM string and has no
 * directory to scan — so `agent.ts`'s own default export carries only the tools
 * it declared INLINE, and `def.tools` in a spec is empty (or short) for every
 * project whose tools are files.
 *
 * A spec has no bundler in its path, so it has to do the same lowering itself,
 * and there is exactly one way to do it:
 *
 * ```ts no-check
 * // `no-check`: import.meta.glob is a Vite transform, so it only type-checks
 * // in a project whose tsconfig has vite/client types — i.e. yours, not here.
 * import { withDiscoveredTools } from "@alexkroman1/aai/testing";
 * import authored from "./agent.ts";
 *
 * const agentDef = withDiscoveredTools(
 *   authored,
 *   import.meta.glob("./tools/*.ts", { eager: true }),
 * );
 * ```
 *
 * **The glob has to be written at the call site, and that is why this takes the
 * result rather than a directory.** `import.meta.glob` is expanded at TRANSFORM
 * time against the file that contains it, so a pattern inside this module would
 * resolve against the SDK's own directory and find nothing. It also cannot take
 * a variable, which is why there is no `withDiscoveredTools(def, "./tools")`.
 *
 * **And it is deliberately not a `readdir` + `import()`.** That would resolve
 * the tool modules through NODE rather than through your test runner, handing
 * them a second copy of `@alexkroman1/aai` — so a `sessionSlot`'s module-level
 * state would differ between the tool under test and the agent holding it,
 * which is the "two physically distinct copies of React" bug wearing a
 * different hat. `import.meta.glob` keeps every module in one graph.
 */

import { type ToolModules, toolRegistry, withTools } from "./tool-registry.ts";
import type { AgentDef } from "./types.ts";

/**
 * The def a DEPLOYED agent runs: the one `agent.ts` exports, plus the tools its
 * `tools/` directory declares.
 *
 * Pass `import.meta.glob("./tools/*.ts", { eager: true })` — see the module doc
 * for why the glob belongs at the call site. Every rule the build applies applies
 * here too, and each is an error naming the file: the name grammar, the
 * default-export requirement, no nested files, and a name declared twice.
 *
 * A project with no `tools/` directory gets an empty glob and the def unchanged.
 *
 * @example
 * ```ts no-check
 * // `no-check`: import.meta.glob needs your project's vite/client types.
 * import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
 * import authored from "./agent.ts";
 *
 * const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));
 *
 * test("adds an item", async () => {
 *   expect(await runTool(agentDef, "add_item", { item: "apple" }, createToolContext())).toEqual({
 *     added: "apple",
 *   });
 * });
 * ```
 *
 * @public
 */
export function withDiscoveredTools<S>(def: AgentDef<S>, modules: ToolModules): AgentDef<S> {
  return withTools(def, toolRegistry<S>(modules));
}
