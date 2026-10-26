// Copyright 2026 the AAI authors. MIT license.
/**
 * Reaching a tool off an agent, for a spec that drives one.
 *
 * A tool's own module exports it, so a spec imports it directly — and that
 * import is how a spec names a tool: the def a tool file default-exports is the
 * very object the deployed agent registered, so handing it to a runner finds
 * the tool in the agent's table by IDENTITY and runs it exactly as the model's
 * call would, gate included. A roster tool is reached the same way, through
 * the speaker's `tools` map entry. Nothing here takes the tool's NAME string:
 * a name is a string, nothing can type what it looks up, and every spec that
 * reached a tool by name then cast the result it got back.
 *
 * {@link toolOf} is the one lookup that still takes a name, because its job is
 * the agent's TABLE — what the agent declares under the name the model calls,
 * for a spec asserting on a description or a minted tool the agent has no file
 * for. Its throw names the tools that do exist, because a lookup that misses is
 * nearly always a RENAME.
 */

import { createToolContext } from "./_testing-context.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import { isRecord } from "./is-record.ts";
import { agentToolsets, composeToolsets, type ToolBearingDef } from "./toolset.ts";
import type { ToolContext, ToolDef } from "./types.ts";

/**
 * The slice of an agent these helpers read: its tool table — the `tools/`
 * files plus every toolset `agent()` attached (a roster's `handoff`, `delegate`
 * and gated tools), gated by its dialogs.
 *
 * Structural rather than `AgentDef`, so a spec may pass the agent's default
 * export, a bare `{ tools }` literal, or anything else carrying one.
 *
 * @input
 * @public
 */
export type ToolBearingAgent = {
  readonly tools: Readonly<Record<string, ToolDef>>;
  readonly dialogs?: readonly AnyDialog[] | undefined;
};

/**
 * The tool `name` is declared under, or a throw naming the ones that are.
 *
 * The LOOKUP, for a spec asserting on what the agent declares — a description,
 * a schema, a tool the roster minted and no file exports (`HANDOFF_TOOL_NAME`).
 * To RUN a tool, hand its def to {@link runTool} or to the runner
 * {@link toolRunner} binds; the def a `tools/` file default-exports is the
 * object the deployed agent registered, so no name is needed to find it.
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
export function toolOf(agent: ToolBearingAgent, name: string): ToolDef {
  return resolveEntry(agent, name).def;
}

/** A def as the lookups below match it: anything carrying an `execute`. */
type ExecuteBearing = { readonly execute: (...args: never[]) => unknown };

/**
 * The tool `nameOrDef` resolves to across the agent's toolsets — by NAME
 * ({@link toolOf}'s lookup) or by IDENTITY (the def a spec imported) — and how
 * a CALL runs it: its toolset's gate first (a roster entry not on the line, a
 * dialog out of state — the refusal comes back as the result), then the
 * toolset's execute.
 *
 * Identity rather than a structural match for the def form, because the
 * registry's entry IS the file's default export (`toolRegistry` stores the
 * exported object, never a copy): the def a spec imported from
 * `tools/add_item.ts` is the very object the deployed agent runs under
 * `add_item`. A def that is not in the table is therefore one the agent does
 * not declare — a tool built inline in the spec, or a file the agent was not
 * imported as DEPLOYED with — and the throw names the tools that are.
 */
function resolveEntry(
  agent: ToolBearingAgent,
  nameOrDef: string | ExecuteBearing,
): { name: string; def: ToolDef; call: ToolDef["execute"] } {
  const lookup = typeof nameOrDef === "string" ? `"${nameOrDef}"` : "def";
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
        ? `toolOf(def, ${lookup}) takes the AGENT, not one tool — this is a tool def, which has no name until a file gives it one. Import the agent from \`virtual:aai/agent\` and name the tool there, or call the def's own \`execute\` directly.`
        : `toolOf(agent, ${lookup}) was handed ${describeHanded(given, "tools")} rather than an agent definition. Import the agent as DEPLOYED: \`import agentDef from "virtual:aai/agent"\` under vitest, or \`deployedAgent\` from @alexkroman1/aai/testing under any other runner.`,
    );
  }
  const table = composeToolsets(agentToolsets(agent as ToolBearingDef));
  const found =
    typeof nameOrDef === "string"
      ? table.resolve(nameOrDef)
      : table.tools.find((one) => one.entry.def === nameOrDef);
  if (!found)
    throw notDeclared(
      table.tools.map((one) => one.name),
      nameOrDef,
    );
  const { name, toolset } = found;
  return {
    name,
    def: found.entry.def,
    call: (args, ctx) => toolset.gate(name, ctx) ?? toolset.execute(name, args, ctx),
  };
}

/** The miss: what was looked up, what the agent declares, and the hint for an empty table. */
function notDeclared(declared: readonly string[], nameOrDef: string | ExecuteBearing): Error {
  const declares = declared.length > 0 ? declared.join(", ") : "(none)";
  const hint = declared.length > 0 ? "" : ` ${AUTHORED_DEF_HINT}`;
  if (typeof nameOrDef === "string") {
    return new Error(
      `The agent declares no tool named ${nameOrDef}. It declares: ${declares}.${hint}`,
    );
  }
  const def: unknown = nameOrDef;
  const described =
    isRecord(def) && typeof def.description === "string"
      ? ` (described as ${JSON.stringify(def.description.slice(0, 60))})`
      : "";
  return new Error(
    `The agent declares no tool that IS this def${described}. It declares: ${declares}. ` +
      "A tool is matched by IDENTITY — import the tool FILE's default export, or a " +
      "speaker's `tools` entry, which is the object the deployed agent registered; a def " +
      `built inline in a spec is not in the table, so call its \`execute\` directly.${hint}`,
  );
}

/**
 * Why an agent declares NO tools, and what to import instead.
 *
 * Shared rather than copied because {@link toolRunner} says it at BIND, where
 * {@link resolveEntry} says it at the first miss: one sentence for one mistake,
 * and the two cannot drift into describing different remedies.
 */
const AUTHORED_DEF_HINT =
  "A tool is a FILE, so an agent.ts default export carries none of them — " +
  'import the agent as DEPLOYED instead: `import agentDef from "virtual:aai/agent"` ' +
  "under vitest, or `deployedAgent` from @alexkroman1/aai/testing under any other runner.";

/**
 * What was passed, for a message that can say so without printing it: a
 * value that is not the agent, tool or def a position takes, named by the
 * member it lacks.
 */
function describeHanded(value: unknown, lacks: "tools" | "execute"): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return `a ${typeof value} with no \`${lacks}\``;
}

/** Is this something with an `execute` — a tool def, by the lookups' own test? */
function isExecuteBearing(value: unknown): value is ExecuteBearing {
  return isRecord(value) && typeof value.execute === "function";
}

/**
 * Run a tool — the tool DEF itself, the way the runtime calls it.
 *
 * **TYPED end to end**: the arguments are checked against what `execute` takes
 * and the result is what it returns, so
 * `await runTool(addItem, { item: "apple" }, ctx)` needs no cast. A tool FILE's
 * default export is the very object a deployed agent registers under its name,
 * so importing it runs the same code the model's call reaches. Matched on
 * `execute` alone rather than on `ToolDef`, so any tool shape — `tool()`,
 * `slot.tool()`, `dialog.tool()` — is accepted and keeps its own result type.
 *
 * UNGATED: this calls the def's own `execute`, as a unit test of the tool body
 * wants. The run a spec cares about is usually the GATED one — a dialog out of
 * state refuses it, a roster entry not on the line refuses it — which is what
 * {@link toolRunner} binds to the agent, and what `describeAgent` hands a suite.
 *
 * `args` is unvalidated on purpose: the runtime parses a model's arguments
 * against `inputSchema` BEFORE `execute` sees them, so a spec that
 * pre-validated would be testing a path the tool never runs on. Pass the
 * arguments the tool body expects to receive. (To test the SCHEMA itself,
 * which is a different question, use `parseToolInput` / `toolInputIssues`.)
 *
 * **A tool that takes no arguments may say so by leaving them out**, passing the
 * context in their place: `runTool(viewOrder, ctx)`. A no-argument tool is
 * common — one shipped template has thirteen — and the `{}` those calls were
 * obliged to pass appeared 66 times across seven template specs, always
 * between the two values a reader actually cares about. The two are told apart
 * by SHAPE, and the probe is narrow enough to be safe: a `ToolContext` is a
 * record carrying a string `sessionId`, a `slots` store and a `send` function,
 * and tool arguments arrive as JSON from a model, which cannot contain a
 * function. A context is never a plausible argument object.
 *
 * @param tool - The tool def: a `tools/` file's default export, a speaker's
 *   `tools` entry, or a def built in the spec.
 * @param argsOrCtx - The tool's arguments, or the {@link ToolContext} when it
 *   takes none. Defaults to `{}`.
 * @param ctx - The context. Defaults to a fresh {@link createToolContext} — so
 *   an omitted context is a DISTINCT SESSION with empty slots, which is what a
 *   stateless tool wants and never what two calls sharing state want. Pass one
 *   explicitly wherever the second call is supposed to see the first call's
 *   work.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { createToolContext, runTool } from "@alexkroman1/aai/testing";
 * import { z } from "zod";
 *
 * // In a spec this is `import addItem from "./tools/add_item.ts"`.
 * const addItem = tool({
 *   description: "Add an item",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: async ({ item }) => ({ added: item }),
 * });
 * const { added } = await runTool(addItem, { item: "apple" }, createToolContext());
 * console.log(added.toUpperCase()); // typed: `added` is a string
 *
 * // No arguments, one session shared across the two calls.
 * const viewOrder = tool({ description: "View the order", execute: () => ({ items: [] }) });
 * const ctx = createToolContext();
 * await runTool(addItem, { item: "apple" }, ctx);
 * const { items } = await runTool(viewOrder, ctx);
 * console.log(items.length);
 * ```
 *
 * @public
 */
export async function runTool<T extends { readonly execute: (...args: never[]) => unknown }>(
  tool: T,
  argsOrCtx?: Parameters<T["execute"]>[0] | ToolContext,
  ctx?: ToolContext,
): Promise<Awaited<ReturnType<T["execute"]>>> {
  return (await execute(tool, argsOrCtx, ctx)) as Awaited<ReturnType<T["execute"]>>;
}

/**
 * Call `tool.execute` the way the runtime does, with the arguments-or-context
 * shape {@link runTool} documents told apart by SHAPE.
 */
async function execute(tool: unknown, argsOrCtx: unknown, ctx: unknown): Promise<unknown> {
  if (!isExecuteBearing(tool)) {
    throw new Error(
      `runTool(tool, …) was handed ${describeHanded(tool, "execute")} rather than a tool. Pass the tool def: a tool file's default export, or a speaker's \`tools\` entry.`,
    );
  }
  const passedContext = ctx ?? (isToolContext(argsOrCtx) ? argsOrCtx : undefined);
  const args = argsOrCtx === undefined || argsOrCtx === passedContext ? {} : argsOrCtx;
  // `Reflect.apply` rather than `tool.execute(...)`: the def's `execute` is
  // typed per tool, and the method receiver is kept exactly as a call would.
  return await Reflect.apply(tool.execute, tool, [args, passedContext ?? createToolContext()]);
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
 * What {@link toolRunner} hands back: a GATED {@link runTool} with the agent
 * already supplied.
 *
 * `run(addItem, { item: "apple" })` checks the arguments against what `execute`
 * takes and answers what it returns, so a spec reads fields off the result with
 * no cast. The def is resolved in the agent's table by IDENTITY (a
 * `tools/<name>.ts` default export IS the registered object, and so is a
 * speaker's `tools` entry), and the call goes through the toolset's GATE — a
 * dialog out of state refuses it, a roster entry not on the line refuses it —
 * exactly as the model's own call would. A def the agent does not declare
 * throws naming the tools it does.
 *
 * Takes the arguments-or-context union {@link runTool} documents: a tool that
 * takes none may be handed the context in their place.
 *
 * Named so a caller can annotate a helper that takes one, and so the union in
 * the second position is written down once here rather than at every call site
 * that binds it.
 *
 * @sealed
 * @public
 */
export type ToolRunner = <T extends { readonly execute: (...args: never[]) => unknown }>(
  tool: T,
  argsOrCtx?: Parameters<T["execute"]>[0] | ToolContext,
  ctx?: ToolContext,
) => Promise<Awaited<ReturnType<T["execute"]>>>;

/**
 * {@link runTool} bound to one agent and GATED by it — the `run(...)` a spec
 * actually calls, and what `describeAgent` hands its body.
 *
 * A spec drives one agent, so `agentDef` is the same in every call and the
 * tool is the thing that varies. Binding the agent is what lets the run go
 * through the agent's own gates: the def is found in the table by identity,
 * its toolset's gate is asked first, and a refusal comes back as the result —
 * a dialog out of state, a roster entry whose speaker is not on the line. The
 * bare {@link runTool} calls the def's `execute` directly, gate and all
 * skipped, which is the unit test of a tool body and not the test of the
 * agent.
 *
 * The runner is stateless and holds only the agent, so one per spec file at the
 * top level is the shape: each call still defaults to a FRESH context, i.e. a
 * distinct session with empty slots. Pass a context explicitly wherever the
 * second call is meant to see the first call's work — see {@link runTool}.
 *
 * @example
 * ```ts
 * // file: tools/add_item.ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Add an item to the order",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }) => ({ added: item }),
 * });
 *
 * // file: tools/view_order.ts
 * import { tool } from "@alexkroman1/aai";
 *
 * export default tool({
 *   description: "View the order",
 *   execute: () => ({ items: ["apple"] }),
 * });
 *
 * // file: agent.test.ts
 * import agentDef from "virtual:aai/agent";
 * import { createToolContext, toolRunner } from "@alexkroman1/aai/testing";
 * import { expect } from "vitest";
 * import addItem from "./tools/add_item.ts";
 * import viewOrder from "./tools/view_order.ts";
 *
 * const run = toolRunner(agentDef);
 *
 * const { added } = await run(addItem, { item: "apple" }); // typed: `added` is a string
 * expect(added).toBe("apple");
 *
 * // No arguments, one session shared across the two calls.
 * const ctx = createToolContext();
 * await run(addItem, { item: "apple" }, ctx);
 * expect(await run(viewOrder, ctx)).toEqual({ items: ["apple"] });
 * ```
 *
 * **A runner over an agent with NO tools is refused HERE**, rather than at the
 * first `run(...)`. A tool is a file, so `agent.ts`'s default export declares an
 * empty table and every call through such a runner fails identically — the
 * mistake is the argument on this line, and reporting it at a call site several
 * dozen lines away names the symptom instead. It is the one shape that cannot be
 * a legitimate runner: a runner exists to reach the agent's tools, and there
 * are none to reach. Reach for {@link toolOf} or {@link runTool} directly if a
 * spec really means to assert on an empty table.
 *
 * @public
 */
export function toolRunner(agent: ToolBearingAgent): ToolRunner {
  const given: unknown = agent;
  // Not an agent at ALL is left to the first call: `toolOf` already has a
  // sentence for each way that happens, and both need the tool to say it.
  if (
    isRecord(given) &&
    isRecord(given.tools) &&
    composeToolsets(agentToolsets(agent)).tools.length === 0
  ) {
    throw new Error(
      "toolRunner(agent) was handed an agent that declares no tools, so every run(…) " +
        `would fail the same way. ${AUTHORED_DEF_HINT}`,
    );
  }
  const run = async (target: unknown, argsOrCtx?: unknown, ctx?: ToolContext): Promise<unknown> => {
    if (!isExecuteBearing(target)) {
      throw new Error(
        `run(…) was handed ${describeHanded(target, "execute")} rather than a tool def. ` +
          "Pass the tool FILE's default export, or a speaker's `tools` entry — the object " +
          "the deployed agent registered.",
      );
    }
    const { call } = resolveEntry(agent, target);
    return await execute({ execute: call }, argsOrCtx, ctx);
  };
  return run as ToolRunner;
}
