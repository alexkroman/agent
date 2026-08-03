// Copyright 2025 the AAI authors. MIT license.

import { normalizeAgentConveniences } from "./_author-conveniences.ts";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import type { AssemblyAITtsVoice } from "./providers/tts/assemblyai.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
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
 * Three author-facing conveniences widen the derived shape (all normalized
 * away by `agent()`, so `AgentDef` stays canonical):
 *
 * - `system` — alias of `systemPrompt`, matching the Vercel AI SDK's field
 *   name. Setting both is an error.
 * - `llm` also accepts a model-id string: `"creator/model"` routes through
 *   the Vercel AI Gateway (`AI_GATEWAY_API_KEY`), a bare id through the
 *   AssemblyAI LLM Gateway (`ASSEMBLYAI_API_KEY`).
 * - `voice` — the TTS voice for the default AssemblyAI pipeline, desugared
 *   to `tts: assemblyAITts({ voice })`. Only valid when no explicit `tts`
 *   descriptor is set (the voice rides on the descriptor there) and never
 *   in S2S mode (the S2S descriptor owns its voice).
 *
 * Pipeline stages are individually optional: declare any subset of
 * `stt`/`llm`/`tts` and the unset stages run on the default all-AssemblyAI
 * pipeline. The shape is still a pipeline-mode/S2S-mode union, so `s2s`
 * combined with a pipeline field fails the build with a message naming the
 * rule ({@link PipelineOnlyMisuse}) rather than failing at the first
 * `aai dev`/`aai deploy`. Configs that never went through `agent()` are
 * still caught at parse time.
 *
 * @public
 */
export type AgentParams<S = DefaultSessionState> = PipelineAgentParams<S> | S2sAgentParams<S>;

/**
 * Fields shared by both session modes: everything on {@link AgentDef} minus
 * the providers and the pipeline-only tuning knobs, plus the authoring
 * conveniences.
 */
export type SharedAgentParams<S = DefaultSessionState> = Omit<
  AgentDef<S>,
  DefaultedAgentField | PipelineOnlyField | ProviderField
> &
  Partial<Pick<AgentDef<S>, DefaultedAgentField>> & {
    /** Alias of `systemPrompt` (the Vercel AI SDK's field name). */
    system?: string;
  };

/** The provider-descriptor fields, mode-owned rather than shared. */
export type ProviderField = "stt" | "llm" | "tts" | "s2s";

/**
 * The {@link AgentDef} fields that only do anything in pipeline mode. On an
 * S2S agent each is typed as a {@link PipelineOnlyMisuse} message, so
 * setting one is a compile error naming the rule instead of a silent no-op.
 */
export type PipelineOnlyField =
  | "sttPrompt"
  | "silenceTimeoutMs"
  | "silencePrompt"
  | "minBargeInWords"
  | "interruptionMinDurationMs"
  | "holdPhrase"
  | "errorPhrase"
  | "startFailurePhrase"
  | "falseInterruptionTimeoutMs";

/**
 * The "type" a pipeline-only field has on an S2S agent — a message, so the
 * compile error for `agent({ s2s: ..., holdPhrase: "..." })` reads
 * *"Type 'string' is not assignable to type '`holdPhrase` is pipeline-mode
 * only …'"* instead of the bare `undefined` mismatch that explains nothing
 * (the lesson `client()`'s ComponentTier already recorded).
 */
export type PipelineOnlyMisuse<K extends PipelineOnlyField> =
  `\`${K}\` is pipeline-mode only — it has no effect on an s2s agent; remove it or remove \`s2s\``;

/**
 * Pipeline-mode params: any subset of the provider triple (unset stages run
 * on the default all-AssemblyAI pipeline), never `s2s`. The `voice`
 * shorthand picks the default pipeline's TTS voice; an explicit `tts`
 * descriptor owns its voice, so combining the two is a compile error naming
 * the rule.
 */
export type PipelineAgentParams<S = DefaultSessionState> = SharedAgentParams<S> &
  Partial<Pick<AgentDef<S>, PipelineOnlyField>> & {
    /** See {@link AgentDef.stt}. Unset → the default AssemblyAI STT. */
    stt?: SttProvider;
    /**
     * See {@link AgentDef.llm}; a string is gateway model-id shorthand.
     * Unset → the default AssemblyAI LLM Gateway model.
     */
    llm?: LlmProvider | string;
    s2s?: undefined;
  } & (
    | {
        /** See {@link AgentDef.tts}. The voice rides on the descriptor. */
        tts: TtsProvider;
        voice?: "`voice` picks the default pipeline's TTS voice — an explicit `tts` descriptor owns its own voice (e.g. `assemblyAITts({ voice })`); set it there or remove `tts`";
      }
    | {
        tts?: undefined;
        /**
         * TTS voice for the default AssemblyAI pipeline — shorthand for
         * `tts: assemblyAITts({ voice })`. See `ASSEMBLYAI_TTS_VOICES`
         * (from `@alexkroman1/aai/tts`) for the catalog; a name outside it
         * fails in-band after connect and leaves the agent silent.
         */
        voice?: AssemblyAITtsVoice;
      }
  );

/**
 * S2S-mode params: an `s2s` descriptor, no pipeline providers, and the
 * pipeline-only tuning knobs typed as {@link PipelineOnlyMisuse} so setting
 * one fails with a message instead of silently doing nothing.
 */
export type S2sAgentParams<S = DefaultSessionState> = SharedAgentParams<S> & {
  /** See {@link AgentDef.s2s} — the explicit opt-in to speech-to-speech mode. */
  s2s: S2sProvider;
  stt?: "`stt` cannot be combined with `s2s` — S2S runs STT service-side";
  llm?: "`llm` cannot be combined with `s2s` — S2S runs the LLM loop service-side";
  tts?: "`tts` cannot be combined with `s2s` — S2S runs TTS service-side";
  voice?: "`voice` is pipeline-mode only — an S2S agent's voice rides on the `s2s` descriptor";
} & {
  [K in PipelineOnlyField]?: PipelineOnlyMisuse<K>;
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
  return {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    greeting: DEFAULT_GREETING,
    maxSteps: DEFAULT_MAX_STEPS,
    tools: {},
    ...(normalizeAgentConveniences(def) as AgentParamsCore<S>),
  };
}

/**
 * `AgentParams` with the author-only conveniences normalized away — what
 * {@link normalizeAgentConveniences} returns and `agent()` spreads over the
 * defaults.
 */
type AgentParamsCore<S> = Omit<AgentDef<S>, DefaultedAgentField> &
  Partial<Pick<AgentDef<S>, DefaultedAgentField>>;
