// Copyright 2026 the AAI authors. MIT license.
/**
 * Reaching a tool off an agent, for a spec that drives one.
 *
 * A tool's own module exports it, so a spec CAN import it directly — but the
 * thing worth testing is usually the tool as the agent declares it: under the
 * name the model calls, present in `agentDef.tools` at all. That lookup is
 * `agentDef.tools[name]`, which is `ToolDef | undefined` under
 * `noUncheckedIndexedAccess`, so every spec that did it wrote the same four
 * lines to turn the `undefined` into a sentence. Four templates had them
 * byte-identical.
 *
 * The sentence is the reason this is worth sharing rather than copying: a
 * lookup that misses is nearly always a RENAME, and the useful error names the
 * tools that do exist. None of the four hand-rolled versions did.
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { ToolContext, ToolDef } from "./types.ts";

/**
 * The slice of an agent these helpers read: its tool table.
 *
 * Structural rather than `AgentDef`, so a spec may pass the agent's default
 * export, a bare `{ tools }` literal, or anything else carrying one.
 *
 * @public
 */
export type ToolBearingAgent = {
  readonly tools: Readonly<Record<string, ToolDef<ToolInputSchema>>>;
};

/**
 * The tool `name` is declared under, or a throw naming the ones that are.
 *
 * A tool is a FILE, so `agent.ts`'s default export declares no tools at all —
 * pass it through `withDiscoveredTools` first, exactly as this example does and
 * as every shipped template's spec does. Handing this the authored def directly
 * is the common mistake, and it fails with "(none)".
 *
 * @example
 * ```ts no-check
 * // `no-check`: import.meta.glob needs your project's vite/client types.
 * import { toolOf, withDiscoveredTools } from "@alexkroman1/aai/testing";
 * import authored from "./agent.ts";
 *
 * const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));
 *
 * expect(toolOf(agentDef, "add_item").description).toContain("cart");
 * ```
 *
 * @public
 */
export function toolOf(agent: ToolBearingAgent, name: string): ToolDef<ToolInputSchema> {
  const def = agent.tools[name];
  if (!def) {
    const declared = Object.keys(agent.tools);
    throw new Error(
      declared.length > 0
        ? `The agent declares no tool named ${name}. It declares: ${declared.join(", ")}.`
        : `The agent declares no tool named ${name}. It declares: (none). ` +
            "A tool is a FILE, so an agent.ts default export carries none of them — " +
            `wrap it with withDiscoveredTools(def, import.meta.glob("./tools/*.ts", { eager: true })) first.`,
    );
  }
  return def;
}

/**
 * Run a tool by the name the model calls it by.
 *
 * `args` is unvalidated on purpose: the runtime parses a model's arguments
 * against `inputSchema` BEFORE `execute` sees them, so a spec that pre-validated
 * would be testing a path the tool never runs on. Pass the arguments the tool
 * body expects to receive.
 *
 * The def to pass is the one a DEPLOYED agent runs — `agent.ts`'s default export
 * put through `withDiscoveredTools`, since a tool is a file and the authored def
 * carries none. See {@link toolOf}, which this is built on.
 *
 * @example
 * ```ts no-check
 * // `no-check`: import.meta.glob needs your project's vite/client types.
 * import { createToolContext, runTool, withDiscoveredTools } from "@alexkroman1/aai/testing";
 * import authored from "./agent.ts";
 *
 * const agentDef = withDiscoveredTools(authored, import.meta.glob("./tools/*.ts", { eager: true }));
 *
 * expect(await runTool(agentDef, "add_item", { item: "apple" }, createToolContext())).toEqual({
 *   added: "apple",
 * });
 * ```
 *
 * @public
 */
export async function runTool(
  agent: ToolBearingAgent,
  name: string,
  args: InferSchemaOutput<ToolInputSchema>,
  ctx: ToolContext,
): Promise<unknown> {
  return await toolOf(agent, name).execute(args, ctx);
}
