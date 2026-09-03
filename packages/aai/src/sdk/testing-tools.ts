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
 * import the agent as DEPLOYED, exactly as this example does and as every
 * shipped template's spec does: `virtual:aai/agent` under vitest, or
 * `deployedAgent` (`@alexkroman1/aai/testing`) under any other runner. Handing
 * this the authored def directly is the common mistake, and it fails with
 * "(none)".
 *
 * @example
 * ```ts
 * import agentDef from "virtual:aai/agent";
 * import { toolOf } from "@alexkroman1/aai/testing";
 * import { expect } from "vitest";
 *
 * expect(toolOf(agentDef, "add_item").description).toContain("cart");
 * ```
 *
 * @public
 */
export function toolOf(agent: ToolBearingAgent, name: string): ToolDef<ToolInputSchema> {
  // Before the lookup, because the value in this position is routinely not an
  // agent at all: a tool def (the thing under test), or the `undefined` a
  // mistyped import answers with. Both used to die on `agent.tools[name]` with
  // a `TypeError` naming neither argument — `Cannot read properties of
  // undefined (reading 'add_item')` — from inside the SDK, which is a worse
  // version of the mistake this function's own doc already handles for the
  // authored-def case.
  const given: unknown = agent;
  if (!(isRecord(given) && isRecord(given.tools))) {
    const looksLikeTool = isRecord(given) && typeof given.execute === "function";
    throw new Error(
      looksLikeTool
        ? `toolOf(def, "${name}") takes the AGENT, not one tool — this is a tool def, which has no name until a file gives it one. Import the agent from \`virtual:aai/agent\` and name the tool there, or call the def's own \`execute\` directly.`
        : `toolOf(agent, "${name}") was handed ${describe(given)} rather than an agent definition. Import the agent as DEPLOYED: \`import agentDef from "virtual:aai/agent"\` under vitest, or \`deployedAgent\` from @alexkroman1/aai/testing under any other runner.`,
    );
  }
  const def = agent.tools[name];
  if (!def) {
    const declared = Object.keys(agent.tools);
    throw new Error(
      declared.length > 0
        ? `The agent declares no tool named ${name}. It declares: ${declared.join(", ")}.`
        : `The agent declares no tool named ${name}. It declares: (none). ` +
            "A tool is a FILE, so an agent.ts default export carries none of them — " +
            'import the agent as DEPLOYED instead: `import agentDef from "virtual:aai/agent"` ' +
            "under vitest, or `deployedAgent` from @alexkroman1/aai/testing under any other runner.",
    );
  }
  return def;
}

/** What was passed, for a message that can say so without printing it. */
function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return `a ${typeof value} with no \`tools\``;
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
 * The def to pass is the one a DEPLOYED agent runs — `virtual:aai/agent` under
 * vitest, or `deployedAgent` under any other runner, since a tool is a file and
 * `agent.ts`'s default export carries none. See {@link toolOf}, which this is
 * built on.
 *
 * **A tool that takes no arguments may say so by leaving them out**, passing the
 * context in their place: `runTool(agentDef, "view_order", ctx)`. A no-argument
 * tool is common — one shipped template has thirteen — and the `{}` those calls
 * were obliged to pass appeared 66 times across seven template specs, always
 * between the two values a reader actually cares about. Both spellings are one
 * signature rather than an overload pair, so a bound runner forwards either
 * shape without restating the union — which is what {@link toolRunner} is, and
 * how every template reaches this.
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
 * ```ts
 * import agentDef from "virtual:aai/agent";
 * import { createToolContext, runTool } from "@alexkroman1/aai/testing";
 * import { expect } from "vitest";
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

/**
 * What {@link toolRunner} hands back: {@link runTool} with the agent already
 * supplied.
 *
 * Named so a caller can annotate a helper that takes one, and so the union in
 * the second position is written down once here rather than at every call site
 * that binds it.
 *
 * @public
 */
export type ToolRunner = (
  name: string,
  argsOrCtx?: InferSchemaOutput<ToolInputSchema> | ToolContext,
  ctx?: ToolContext,
) => Promise<unknown>;

/**
 * {@link runTool} bound to one agent — the `run(...)` a spec actually calls.
 *
 * A spec drives one agent, so `agentDef` is the same in every call and the name
 * is the thing that varies. Every shipped template therefore opened with the
 * same wrapper:
 *
 * ```ts no-check
 * const run = (name: string, argsOrCtx?: Record<string, unknown> | ToolContext, ctx?: ToolContext) =>
 *   runTool(agentDef, name, argsOrCtx, ctx);
 * ```
 *
 * Ten of them, and {@link runTool}'s own documentation named that wrapper as how
 * every template reaches it — which is the point at which the wrapper is part of
 * the API and belongs in it. `const run = toolRunner(agentDef);` is the same
 * thing in one line.
 *
 * **The union is what is worth removing, not the line.** A spec that writes the
 * signature out has to restate `Record<string, unknown> | ToolContext` to
 * forward both of `runTool`'s shapes — arguments, or the context in their place
 * for a tool that takes none — and a spec that narrows it to
 * `(name: string, args: Record<string, unknown>)` has quietly given up the
 * second shape. Four templates had; three of those then passed `{}` by hand
 * where the whole point of the shorter form is not having to. Binding the agent
 * keeps the union in one place, where it stays right.
 *
 * The runner is stateless and holds only the agent, so one per spec file at the
 * top level is the shape: each call still defaults to a FRESH context, i.e. a
 * distinct session with empty slots. Pass a context explicitly wherever the
 * second call is meant to see the first call's work — see {@link runTool}.
 *
 * @example
 * ```ts
 * import agentDef from "virtual:aai/agent";
 * import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
 * import { expect } from "vitest";
 *
 * const run = toolRunner(agentDef);
 *
 * expect(await run("add_item", { item: "apple" })).toEqual({ added: "apple" });
 *
 * // No arguments, one session shared across the two calls.
 * const ctx = createToolContext();
 * await run("add_item", { item: "apple" }, ctx);
 * expect(await run("view_order", ctx)).toEqual({ items: ["apple"] });
 * ```
 *
 * @public
 */
export function toolRunner(agent: ToolBearingAgent): ToolRunner {
  return async (name, argsOrCtx, ctx) => await runTool(agent, name, argsOrCtx, ctx);
}
