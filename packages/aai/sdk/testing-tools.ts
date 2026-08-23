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

import { createToolContext } from "./_testing-context.ts";
import { isRecord } from "./is-record.ts";
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
 * body expects to receive. (To test the SCHEMA itself, which is a different
 * question, use `parseToolInput` / `toolInputIssues`.)
 *
 * The def to pass is the one a DEPLOYED agent runs — `agent.ts`'s default export
 * put through `withDiscoveredTools`, since a tool is a file and the authored def
 * carries none. See {@link toolOf}, which this is built on.
 *
 * **A tool that takes no arguments may say so by leaving them out**, passing the
 * context in their place: `runTool(agentDef, "view_order", ctx)`. A no-argument
 * tool is common — one shipped template has thirteen — and the `{}` those calls
 * were obliged to pass appeared 66 times across seven template specs, always
 * between the two values a reader actually cares about. Both spellings are one
 * signature rather than an overload pair, so a local
 * `run = (name, argsOrCtx, ctx?) => runTool(agentDef, name, argsOrCtx, ctx)`
 * wrapper — which is how every template reaches this — forwards either shape
 * without restating the union.
 *
 * The two are told apart by SHAPE, and the probe is narrow enough to be safe:
 * a `ToolContext` is a record carrying a string `sessionId`, a `slots` store and
 * a `send` function, and tool arguments arrive as JSON from a model, which
 * cannot contain a function. A context is never a plausible argument object.
 *
 * @param args - The tool's arguments, or the {@link ToolContext} when it takes
 *   none. Defaults to `{}`.
 * @param ctx - The context. Defaults to a fresh {@link createToolContext} — so
 *   an omitted context is a DISTINCT SESSION with empty slots, which is what a
 *   stateless tool wants and never what two calls sharing state want. Pass one
 *   explicitly wherever the second call is supposed to see the first call's
 *   work.
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
 *
 * // No arguments, one session shared across the two calls.
 * const ctx = createToolContext();
 * await runTool(agentDef, "add_item", { item: "apple" }, ctx);
 * expect(await runTool(agentDef, "view_order", ctx)).toEqual({ items: ["apple"] });
 * ```
 *
 * @public
 */
export async function runTool(
  agent: ToolBearingAgent,
  name: string,
  argsOrCtx?: InferSchemaOutput<ToolInputSchema> | ToolContext,
  ctx?: ToolContext,
): Promise<unknown> {
  const passedContext = ctx ?? (isToolContext(argsOrCtx) ? argsOrCtx : undefined);
  const args = argsOrCtx === undefined || argsOrCtx === passedContext ? {} : argsOrCtx;
  return await toolOf(agent, name).execute(args, passedContext ?? createToolContext());
}

/**
 * Is this a {@link ToolContext} rather than a bag of tool arguments?
 *
 * Three fields, all of them present on every context this SDK builds and none of
 * them expressible in the JSON a model sends: `send` is a FUNCTION, which is the
 * one that cannot be faked by an argument object arriving over the wire.
 */
function isToolContext(value: unknown): value is ToolContext {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.send === "function" &&
    isRecord(value.slots)
  );
}
