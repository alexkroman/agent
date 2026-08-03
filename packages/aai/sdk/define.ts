// Copyright 2025 the AAI authors. MIT license.

import { DEFAULT_MAX_STEPS } from "./constants.ts";
import { normalizeLlm } from "./providers/llm/from-string.ts";
import type { LlmProvider } from "./providers.ts";
import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import {
  type AgentDef,
  DEFAULT_GREETING,
  DEFAULT_SYSTEM_PROMPT,
  type DefaultSessionState,
  type ToolContext,
  type ToolDef,
} from "./types.ts";

/**
 * Define a tool with a typed input schema and execute function.
 *
 * Identity function for type inference — returns the input unchanged.
 * Follows the Vercel AI SDK `tool()` pattern (`inputSchema` names the same
 * field it does there). The schema is any Standard Schema that converts to
 * JSON Schema; Zod is the documented default.
 *
 * @example
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * const greet = tool({
 *   description: "Greet someone by name",
 *   inputSchema: z.object({ name: z.string() }),
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
 * import { tool, type ToolContext } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * type Cart = { items: string[] };
 *
 * const add = tool({
 *   description: "Add an item to the cart",
 *   inputSchema: z.object({ item: z.string() }),
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
export function tool<P extends ToolInputSchema = ToolInputSchema, S = DefaultSessionState>(def: {
  description: string;
  inputSchema?: P;
  execute(args: InferSchemaOutput<P>, ctx: ToolContext<S>): Promise<unknown> | unknown;
}): ToolDef<P, S> {
  return def;
}

/** The {@link AgentDef} fields `agent()` fills with defaults when omitted. */
export type DefaultedAgentField = "systemPrompt" | "greeting" | "maxSteps" | "tools";

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
 * Two author-facing conveniences widen the derived shape (both normalized
 * away by `agent()`, so `AgentDef` stays canonical):
 *
 * - `system` — alias of `systemPrompt`, matching the Vercel AI SDK's field
 *   name. Setting both is an error.
 * - `llm` also accepts a model-id string: `"creator/model"` routes through
 *   the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), a bare id through the
 *   AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`).
 *
 * @public
 */
export type AgentParams<S = DefaultSessionState> = Omit<AgentDef<S>, DefaultedAgentField | "llm"> &
  Partial<Pick<AgentDef<S>, DefaultedAgentField>> & {
    /** See {@link AgentDef.llm}; a string is gateway model-id shorthand. */
    llm?: LlmProvider | string;
    /** Alias of `systemPrompt` (the Vercel AI SDK's field name). */
    system?: string;
  };

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
 *   inputSchema: z.object({ message: z.string() }),
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
 * Session mode: with no provider fields the agent runs the default
 * all-AssemblyAI cascaded pipeline (`assemblyAIPipeline()`). Pass `stt`,
 * `llm`, and `tts` together to pick different pipeline providers (all three
 * or none), or set `s2s` (e.g. `assemblyAIS2s()`) to opt into the
 * speech-to-speech path instead. See {@link AgentDef} for every field.
 *
 * @public
 */
export function agent<S = DefaultSessionState>(def: AgentParams<S>): AgentDef<S> {
  const { system, llm, ...rest } = def;
  if (system !== undefined && rest.systemPrompt !== undefined) {
    throw new Error("agent(): `system` and `systemPrompt` are aliases — set one, not both.");
  }
  return {
    systemPrompt: system ?? DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...rest,
    ...(llm !== undefined ? { llm: normalizeLlm(llm) } : {}),
  };
}
