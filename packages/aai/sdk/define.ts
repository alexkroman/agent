// Copyright 2025 the AAI authors. MIT license.

import { normalizeAgentConveniences } from "./_author-conveniences.ts";
import type { AgentParams, DefaultedAgentField, StaticAgentParams } from "./agent-params.ts";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import { omitUndefined } from "./omit-undefined.ts";
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

/**
 * Define an agent: its system prompt, its providers, and its configuration.
 *
 * Applies sensible defaults for omitted fields. Export as the default
 * export of your `agent.ts` file.
 *
 * **Tools are not declared here** — a tool is a FILE. `tools/echo.ts` that
 * default-exports `tool({ … })` is the tool `echo`, registered by existing, and
 * `agent({ tools })` is a compile error naming the file to create
 * ({@link InlineToolsMisuse}).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "Echo Agent",
 *   greeting: "Say something and I'll say it back.",
 * });
 * ```
 *
 * @typeParam S - Per-session state, inferred from the `state` factory. A
 *   {@link sessionSlot} is what carries that shape into a tool's own module —
 *   `slot.tool()` hands the body the live value, so a tool in another file needs
 *   neither an annotated `ctx` nor a cast.
 *
 * @remarks
 * Session mode: with no provider fields the agent runs the default
 * all-AssemblyAI cascaded pipeline. Set any subset of `stt`, `llm`, `tts`
 * to swap individual stages (unset stages keep the AssemblyAI default), and
 * `voice` to pick the default pipeline's TTS voice — or set `s2s` (e.g.
 * `assemblyAIS2s()`) to opt into the speech-to-speech path instead. See
 * {@link AgentDef} for every field.
 *
 * @example Default pipeline with a voice and a different LLM
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 *
 * export default agent({
 *   name: "My Agent",
 *   voice: "michael",
 *   llm: "claude-sonnet-4-6",
 * });
 * ```
 *
 * @public
 */
export function agent<S = DefaultSessionState>(def: AgentParams<S>): AgentDef<S> {
  assertNoInlineTools(def);
  /**
   * `omitUndefined` because a spread lets an own key whose value is
   * `undefined` WIN over the default beneath it. Writing
   * `agent({ greeting: undefined })` is already a compile error under
   * `exactOptionalPropertyTypes` — but `agent({ name, ...opts })`, where
   * `opts` is declared `{ greeting?: string; maxSteps?: number }`, is not, and
   * that is how an options bag reaches here. It returned an agent whose
   * `greeting`, `systemPrompt` and `maxSteps` were all `undefined` while every
   * one of them is typed as REQUIRED on {@link AgentDef} — so the agent opened
   * on silence, ran on no system prompt, and the pipeline's `stopWhen` budget
   * was `NaN`, with nothing anywhere reporting it.
   *
   * Making absent and present-and-undefined mean the same thing is what those
   * fields' docs ("Defaults to …") already promise. The cast back is the same
   * one the normalize call needs — `omitUndefined` widens every key to
   * optional, and `name` is not.
   */
  const params = omitUndefined(
    normalizeAgentConveniences(def) as AgentParamsCore<S>,
  ) as AgentParamsCore<S>;
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...params,
  };
}

/**
 * Refuse a `tools` key at RUN TIME as well as in the type.
 *
 * {@link InlineToolsMisuse} is the compile error, and on its own it leaves the
 * rule conventional: neither bundler type-checks user code, so a `tools` map
 * that reached here would work — and "a tool is only ever a file" would be true
 * of the templates and of nothing else. It is also exactly the shape an options
 * bag reaches `agent()` in, where the excess-property check does not fire.
 *
 * Thrown rather than dropped, on the rule this whole mechanism exists for: the
 * failure being replaced was a tool that silently never reached the model, and
 * silently ignoring a declared one is that failure with a new cause.
 */
function assertNoInlineTools(def: unknown): void {
  if (typeof def !== "object" || def === null || !("tools" in def)) return;
  throw new Error(
    "agent({ tools }) is not how a tool is declared: a tool IS a file. Move each entry to " +
      "tools/<the name the model calls>.ts as `export default tool({ … })` — the build enumerates " +
      "that directory, so nothing lists them anywhere. In a spec, reach the same set with " +
      "withDiscoveredTools from @alexkroman1/aai/testing.",
  );
}

/**
 * Define a WORKFLOW APP — an agent whose front door is a form rather than a
 * microphone, and whose work happens in `workflows`.
 *
 * `agent({ …, page: "static" })` with the discriminant already set, so the
 * mode is the CALL rather than a field to remember, and the fields a workflow
 * app has no use for are absent from the parameter type instead of being
 * rejected by it. Returns the same {@link AgentDef} `agent()` does — there is
 * one definition type, one config, one deploy path, and `page` is only ever
 * about the front door.
 *
 * It mirrors the split `@alexkroman1/aai-ui` already makes in the browser:
 * `page()` mounts a workflow app's UI and `client()` mounts a voice one,
 * because a flag would leave every session-shaped question ("what does this
 * mean with no session?") answered by a conditional. Same reasoning, same
 * seam, other end of the wire.
 *
 * @example
 * ```ts
 * import { workflow, workflowApp } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export const digest = workflow({
 *   description: "Summarize a link",
 *   input: z.object({ url: z.url() }),
 *   run: async ({ url }) => ({ url }),
 * });
 *
 * export default workflowApp({
 *   name: "Link Digest",
 *   workflows: { digest },
 * });
 * ```
 *
 * @public
 */
export function workflowApp(def: Omit<StaticAgentParams, "page">): AgentDef {
  return agent({ ...def, page: "static" });
}

/**
 * `AgentParams` with the author-only conveniences normalized away — what
 * {@link normalizeAgentConveniences} returns and `agent()` spreads over the
 * defaults.
 */
type AgentParamsCore<S> = Omit<AgentDef<S>, DefaultedAgentField> &
  Partial<Pick<AgentDef<S>, DefaultedAgentField>>;

// The parameter shape lives in its own module (see its header); re-exported here
// so `agent()` and its params stay one import for an author, and so the root
// barrel's surface is unchanged by the split.
export type {
  AgentParams,
  DefaultedAgentField,
  FrontDoorField,
  InlineToolsField,
  InlineToolsMisuse,
  PipelineAgentParams,
  PipelineOnlyField,
  PipelineOnlyMisuse,
  ProviderField,
  S2sAgentParams,
  SharedAgentParams,
  StaticAgentParams,
  StaticFrontDoorMisuse,
  TextAgentParams,
  WorkflowAppMisuse,
  WorkflowAppOnlyField,
} from "./agent-params.ts";
