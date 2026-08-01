// Copyright 2025 the AAI authors. MIT license.

import type { z } from "zod";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import {
  type AgentDef,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
  type ToolContext,
  type ToolDef,
} from "./types.ts";

/**
 * Define a tool with typed parameters and execute function.
 *
 * Identity function for type inference — returns the input unchanged.
 * Follows the Vercel AI SDK `tool()` pattern.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const greet = tool({
 *   description: "Greet someone by name",
 *   parameters: z.object({ name: z.string() }),
 *   execute: ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 *
 * @typeParam S - The agent's per-session state, so `ctx.state` is typed
 *   rather than `Record<string, unknown>`. Inferred when the handler
 *   annotates its context; otherwise pass it explicitly. A tool defined
 *   without it still composes into a stateful agent — `execute` is declared
 *   method-style, so it stays assignable — it just sees untyped state.
 *
 * @example Typed session state
 * ```ts
 * type Cart = { items: string[] };
 *
 * const add = tool({
 *   description: "Add an item to the cart",
 *   parameters: z.object({ item: z.string() }),
 *   // The annotation is what infers S; `ctx.state.items` is string[] here.
 *   execute: ({ item }, ctx: ToolContext<Cart>) => {
 *     ctx.state.items.push(item);
 *     return ctx.state.items.length;
 *   },
 * });
 * ```
 *
 * @public
 */
export function tool<P extends z.ZodObject<z.ZodRawShape>, S = Record<string, unknown>>(def: {
  description: string;
  parameters?: P;
  execute(args: z.infer<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
}): ToolDef<P, S> {
  return def;
}

/** {@link AgentDef} fields `agent()` fills in when omitted. */
type DefaultedAgentField = "systemPrompt" | "greeting" | "maxSteps" | "tools";

/**
 * The author-facing parameter shape of {@link agent}: every {@link AgentDef}
 * field, with the defaulted ones optional.
 *
 * Derived from `AgentDef` rather than re-declared, so a field added there is
 * automatically declarable here — the inline re-declaration this replaces let
 * fields (`send`, `state`) ship as runtime-working but excess-property errors
 * for authors, because neither bundler typechecks user code. Field docs live
 * on {@link AgentDef} and carry through the mapped types.
 *
 * @public
 */
export type AgentParams<S = Record<string, unknown>> = Omit<AgentDef<S>, DefaultedAgentField> &
  Partial<Pick<AgentDef<S>, DefaultedAgentField>>;

/**
 * Define an agent with tools, system prompt, and configuration.
 *
 * Applies sensible defaults for omitted fields. Export as the default
 * export of your `agent.ts` file.
 *
 * @example
 * ```ts
 * import { agent, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const myTool = tool({
 *   description: "Echo a message",
 *   parameters: z.object({ message: z.string() }),
 *   execute: ({ message }) => message,
 * });
 *
 * export default agent({
 *   name: "Echo Agent",
 *   tools: { echo: myTool },
 * });
 * ```
 *
 * @typeParam S - Per-session state, inferred from the `state` factory. Tools
 *   are then checked against it, so a tool reading `ctx.state` under a
 *   different shape is a compile error rather than a runtime surprise.
 *
 * @remarks
 * Pipeline mode: pass `stt`, `llm`, and `tts` together to switch from the
 * default AssemblyAI Streaming Speech-to-Speech path to a pluggable
 * STT → LLM → TTS pipeline. All three must be set (or all left unset).
 * See {@link AgentDef} for the documentation of every field.
 *
 * @public
 */
export function agent<S = Record<string, unknown>>(def: AgentParams<S>): AgentDef<S> {
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...def,
  };
}
