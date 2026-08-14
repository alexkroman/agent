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
import type { DefaultSessionState, ToolContext, ToolDef } from "./types.ts";

/**
 * The slice of an agent these helpers read: its tool table.
 *
 * Structural rather than `AgentDef`, so a spec may pass the agent's default
 * export, a bare `{ tools }` literal, or anything else carrying one.
 *
 * @public
 */
export type ToolBearingAgent<S = DefaultSessionState> = {
  readonly tools: Readonly<Record<string, ToolDef<ToolInputSchema, S>>>;
};

/**
 * The tool `name` is declared under, or a throw naming the ones that are.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the agent under test is in another file, which is the point.
 * import { toolOf } from "@alexkroman1/aai/testing";
 * import agentDef from "./agent.ts";
 *
 * expect(toolOf(agentDef, "add_item").description).toContain("cart");
 * ```
 *
 * @public
 */
export function toolOf<S>(agent: ToolBearingAgent<S>, name: string): ToolDef<ToolInputSchema, S> {
  const def = agent.tools[name];
  if (!def) {
    const declared = Object.keys(agent.tools);
    throw new Error(
      `The agent declares no tool named ${name}. It declares: ${
        declared.length > 0 ? declared.join(", ") : "(none)"
      }.`,
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
 * @example
 * ```ts no-check
 * // `no-check`: the agent under test is in another file, which is the point.
 * import { createToolContext, runTool } from "@alexkroman1/aai/testing";
 * import agentDef from "./agent.ts";
 *
 * const ctx = createToolContext();
 * expect(await runTool(agentDef, "add_item", { item: "apple" }, ctx)).toEqual({ added: "apple" });
 * ```
 *
 * @public
 */
export async function runTool<S>(
  agent: ToolBearingAgent<S>,
  name: string,
  args: InferSchemaOutput<ToolInputSchema>,
  ctx: ToolContext<S>,
): Promise<unknown> {
  return await toolOf(agent, name).execute(args, ctx);
}
