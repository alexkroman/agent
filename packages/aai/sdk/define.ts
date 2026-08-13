// Copyright 2025 the AAI authors. MIT license.

import { normalizeAgentConveniences } from "./_author-conveniences.ts";
import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
import { DEFAULT_MAX_STEPS } from "./constants.ts";
import { omitUndefined } from "./omit-undefined.ts";
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
 * pipeline. The shape is a union over the three session modes — pipeline,
 * S2S ({@link S2sAgentParams}) and text ({@link TextAgentParams}) — so a
 * field belonging to another mode fails the build with a message naming the
 * rule ({@link PipelineOnlyMisuse}) rather than failing at the first
 * `aai dev`/`aai deploy`. Configs that never went through `agent()` are
 * still caught when `toAgentConfig` runs in the bundle entry.
 *
 * The fourth arm ({@link StaticAgentParams}) is the WORKFLOW APP, and it is
 * keyed on the front door rather than on a session mode: `page: "static"` has
 * no session at all, so every field the other three arms exist to arbitrate
 * between is inert there. {@link workflowApp} is the same arm with the
 * discriminant already set.
 *
 * @public
 */
export type AgentParams<S = DefaultSessionState> =
  | PipelineAgentParams<S>
  | S2sAgentParams<S>
  | TextAgentParams<S>
  | StaticAgentParams;

/**
 * Fields shared by both session modes: everything on {@link AgentDef} minus
 * the providers and the pipeline-only tuning knobs, plus the authoring
 * conveniences.
 */
export type SharedAgentParams<S = DefaultSessionState> = Omit<
  AgentDef<S>,
  DefaultedAgentField | PipelineOnlyField | ProviderField | FrontDoorField
> &
  Partial<Pick<AgentDef<S>, DefaultedAgentField>> & {
    /** Alias of `systemPrompt` (the Vercel AI SDK's field name). */
    system?: string;
  };

/**
 * The field naming what an agent's front door IS, subtracted from
 * {@link SharedAgentParams} so each arm re-declares the value it accepts.
 *
 * Without the subtraction the three voice arms accept `page: "static"` too, and
 * a union arm that every other arm also matches never bites: `agent({ voice:
 * "michael", page: "static" })` would resolve against {@link
 * PipelineAgentParams} and configure a TTS voice for an app that never speaks.
 */
export type FrontDoorField = "page";

/**
 * The mode-owned fields: the four provider descriptors and the `text`
 * opt-in. Subtracted from {@link SharedAgentParams} so each mode arm
 * re-declares exactly the ones it accepts and types the rest as a message.
 */
export type ProviderField = "stt" | "llm" | "tts" | "s2s" | "text";

/**
 * The {@link AgentDef} fields that only do anything in pipeline mode. On an
 * S2S agent each is typed as a {@link PipelineOnlyMisuse} message, so
 * setting one is a compile error naming the rule instead of a silent no-op.
 *
 * The voice-UX knobs are DERIVED from {@link PipelineVoiceTuning} rather than
 * re-listed, so a field added to that interface gets this compile error for
 * free. The two hand-listed names are the silence-nudge fields, which are not
 * voice-UX tuning but share the rule.
 *
 * `sttPrompt` used to be listed here and no longer is. S2S has forwarded it as
 * `input.transcription_prompt` since 2026-08-06, so the type was rejecting a
 * field the runtime honours and {@link AgentDef.sttPrompt} documents as working
 * in both modes — leaving the measured win (a spelled first name going from 1
 * of 6 attempts correct to 6 of 6) reachable only by skipping `agent()` for a
 * raw `export default {...}`. Removing it is purely WIDENING: the field falls
 * through to {@link SharedAgentParams}, which turns a compile error into legal
 * code and breaks no existing agent.
 */
export type PipelineOnlyField = keyof PipelineVoiceTuning | "silenceTimeoutMs" | "silencePrompt";

/**
 * The "type" a pipeline-only field has outside pipeline mode — a message, so
 * the compile error for `agent({ s2s: ..., deadAirCoverMs: 5000 })` reads
 * *"Type 'number' is not assignable to type '`deadAirCoverMs` is pipeline-mode
 * only …'"* instead of the bare `undefined` mismatch that explains nothing
 * (the lesson `client()`'s ComponentTier already recorded).
 *
 * `M` names the mode the author is actually in, so the remedy the message
 * gives ("remove `s2s`" / "remove `text`") is the one that applies to the
 * agent in front of them rather than a menu.
 */
export type PipelineOnlyMisuse<
  K extends PipelineOnlyField,
  M extends "s2s" | "text" = "s2s",
> = `\`${K}\` is pipeline-mode only — it has no effect on a ${M} agent; remove it or remove \`${M}\``;

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
    text?: undefined;
    /** See {@link AgentDef.page}. A pipeline agent's front door is a mic. */
    page?: "voice" | StaticFrontDoorMisuse;
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
  text?: "`text` cannot be combined with `s2s` — an agent is text-only or speech-to-speech, not both";
  /** See {@link AgentDef.page}. An S2S agent's front door is a mic. */
  page?: "voice" | StaticFrontDoorMisuse;
} & {
  [K in PipelineOnlyField]?: PipelineOnlyMisuse<K>;
};

/**
 * Text-mode params: `text: true`, optionally an `llm`, and nothing else from
 * the audio half of the agent shape.
 *
 * Every speech field is typed as a message rather than left absent, on the
 * same reasoning as {@link S2sAgentParams}: a bare excess-property error
 * names the field and not the rule, and the rule here ("a text agent has no
 * audio path") is exactly what an author moving a voice agent to text needs
 * told. `sttPrompt` is included even though it is otherwise mode-agnostic —
 * it biases a transcriber, and there is none.
 *
 * The pipeline-only voice knobs are derived from {@link PipelineOnlyField},
 * so a knob added to {@link PipelineVoiceTuning} is rejected here for free.
 */
export type TextAgentParams<S = DefaultSessionState> = Omit<SharedAgentParams<S>, "sttPrompt"> & {
  /** See {@link AgentDef.text} — the explicit opt-in to text mode. */
  text: true;
  /**
   * See {@link AgentDef.llm}; a string is gateway model-id shorthand. Unset →
   * the default AssemblyAI LLM Gateway model. The one provider stage a text
   * agent has.
   */
  llm?: LlmProvider | string;
  stt?: "`stt` cannot be combined with `text` — a text agent has no audio to transcribe";
  tts?: "`tts` cannot be combined with `text` — a text agent has no audio to synthesize";
  s2s?: "`s2s` cannot be combined with `text` — an agent is text-only or speech-to-speech, not both";
  voice?: "`voice` is pipeline-mode only — a text agent never speaks";
  sttPrompt?: "`sttPrompt` biases a transcriber — a text agent has none; remove it or remove `text`";
  /**
   * See {@link AgentDef.page}. A text agent has no browser front door of its
   * own — it is driven by `createTextAgent`, not by a page.
   */
  page?: "voice" | StaticFrontDoorMisuse;
} & {
  [K in PipelineOnlyField]?: PipelineOnlyMisuse<K, "text">;
};

/**
 * The "type" `page` has on the three VOICE arms, so `page: "static"` beside a
 * voice field fails with the rule rather than with
 * `Type '"static"' is not assignable to type '"voice"'` — which names the
 * field and not what to do about it. Same idiom as {@link PipelineOnlyMisuse}.
 */
export type StaticFrontDoorMisuse =
  '`page: "static"` declares a WORKFLOW APP, which runs no model and opens no socket — remove this agent\'s voice/LLM fields, or declare it with `workflowApp()` and keep them off by construction';

/**
 * The {@link AgentDef} fields a WORKFLOW APP cannot use, typed as messages on
 * {@link StaticAgentParams}.
 *
 * A `page: "static"` agent has no session and no LLM loop: nothing reads a
 * system prompt, nothing executes a tool, nothing opens the socket `syncState`
 * pushes over. Every one of these was silently ACCEPTED and inert before this
 * arm existed, and the `link-digest` template shipped a `systemPrompt`
 * addressed to a model that never runs — with a comment claiming
 * `GET /client-config` served it, which serves `name`/`greeting`/`page` and
 * has never carried a system prompt.
 *
 * Derived from the two existing lists where they already say this, so a new
 * pipeline knob or provider stage is rejected here for free.
 */
export type WorkflowAppOnlyField =
  | ProviderField
  | PipelineOnlyField
  | "system"
  | "systemPrompt"
  | "sttPrompt"
  | "maxSteps"
  | "toolChoice"
  | "tools"
  | "builtinTools"
  | "state"
  | "syncState"
  | "idleTimeoutMs"
  | "voice";

/** The message a {@link WorkflowAppOnlyField} carries. */
export type WorkflowAppMisuse<K extends string> =
  `\`${K}\` has no effect on a workflow app — \`page: "static"\` runs no model and opens no session; remove it, or remove \`page: "static"\` to make this a voice agent`;

/**
 * Workflow-app params: `page: "static"`, the workflows that ARE the product,
 * and nothing from the session half of the agent shape.
 *
 * Not a session mode like the other three arms — a front door. What it drops is
 * everything downstream of having a session at all, which is why it takes no
 * `S`: `state` is per-session state and there are no sessions.
 *
 * What it keeps is the surface a page and a deploy actually read: `name` and
 * `greeting` (both served by `GET /client-config`, so a page can render its
 * shell from the agent — `page()` does not fetch it the way `client()` does, so
 * a page that wants them calls `fetchClientConfig()` itself), `workflows`, and
 * `requiredEnv` (a `"use step"` body reads keys with `stepEnv` from
 * `@alexkroman1/aai/utils`, and a deploy still checks they are present).
 *
 * `workflows` is REQUIRED here, unlike on {@link AgentDef}: a workflow app whose
 * whole API is `/workflows/*` and which declares none serves a form with nothing
 * behind it, and the page's `api.start(name, …)` would 400 on every submit.
 */
export type StaticAgentParams = Omit<
  SharedAgentParams,
  WorkflowAppOnlyField | FrontDoorField | "workflows"
> & {
  /** See {@link AgentDef.page} — the explicit opt-in to a workflow app. */
  page: "static";
  /**
   * See {@link AgentDef.workflows}. The whole product: a workflow app is an
   * agent whose work happens here.
   */
  workflows: NonNullable<AgentDef["workflows"]>;
} & {
  [K in WorkflowAppOnlyField]?: WorkflowAppMisuse<K>;
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
