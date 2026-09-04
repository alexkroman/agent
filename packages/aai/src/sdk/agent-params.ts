// Copyright 2026 the AAI authors. MIT license.
/**
 * The author-facing PARAMETER SHAPE of `agent()` — and only that.
 *
 * Split out of `define.ts` because the two are different jobs: that file holds
 * the three constructors an author calls, this one holds the union that decides
 * what a call may say, which is most of the type-level machinery in the SDK.
 * Every name here is re-exported from `define.ts` (and so from the root), so the
 * split is invisible to a consumer and to the capability contracts.
 *
 * What makes it a coherent module rather than an arbitrary cut: every type in it
 * is either a FIELD LIST subtracted from the shared shape, or the MESSAGE a
 * subtracted field is re-typed as. The pattern is one idea — a mode mistake
 * should be a compile error that names the rule, not a bare
 * `Type 'X' is not assignable to type 'undefined'` — applied five times, once
 * per thing a declaration can get wrong: a pipeline knob on a non-pipeline
 * agent, a provider on the wrong mode, `page: "static"` on a voice agent, a
 * session field on a workflow app, and a `tools` map on anything at all.
 */

import type { StaticAgentParamsCore } from "./agent-params-static.ts";
import type { PipelineVoiceTuning } from "./agent-voice-tuning.ts";
import type { AssemblyAITtsVoice } from "./providers/tts/assemblyai.ts";
import type { LlmProvider, S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDef } from "./types.ts";

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
 * Four author-facing conveniences widen the derived shape (all normalized
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
 * - `minTurnSilenceMs` / `maxTurnSilenceMs` — the end-of-turn window for the
 *   default AssemblyAI STT stage, desugared to `stt: assemblyAIStt({ … })`.
 *   Same rule as `voice`: only valid when no explicit `stt` descriptor is set.
 *   `maxTurnSilenceMs` is the pause-tolerance knob, and it is here because it
 *   is the highest-value tuning an agent has and used to be the highest-friction
 *   to express — one number cost a whole stage descriptor, which then silently
 *   dropped whatever else the default fill would have supplied.
 *
 * Pipeline stages are individually optional: declare any subset of
 * `stt`/`llm`/`tts` and the unset stages run on the default all-AssemblyAI
 * pipeline. The shape is a union over the three session modes — pipeline,
 * S2S ({@link S2sAgentParams}) and text ({@link TextAgentParams}) — so a
 * field belonging to another mode fails the build with a message naming the
 * rule (`PipelineOnlyMisuse`) rather than failing at the first
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
export type AgentParams =
  | PipelineAgentParams
  | S2sAgentParams
  | TextAgentParams
  // The message-free arm: see `StaticAgentParamsCore`. `workflowApp()` takes
  // the arm that carries the workflow-app diagnostics.
  | StaticAgentParamsCore;

/**
 * Fields shared by both session modes: everything on {@link AgentDef} minus
 * the providers and the pipeline-only tuning knobs, plus the authoring
 * conveniences.
 */
export type SharedAgentParams = Omit<
  AgentDef,
  DefaultedAgentField | PipelineOnlyField | ProviderField | FrontDoorField
> &
  Partial<Pick<AgentDef, Exclude<DefaultedAgentField, InlineToolsField>>> & {
    /**
     * Not a field. See `InlineToolsMisuse` — a tool is declared by its
     * FILE, so this is typed as the message that names the one to create.
     */
    tools?: InlineToolsMisuse;
  };

/**
 * The field a tool USED to be declared with, subtracted from
 * {@link SharedAgentParams} so it can be re-typed as a message.
 *
 * Its own name rather than an inline `"tools"` for the reason
 * {@link FrontDoorField} has one: the subtraction is what makes the rule, and a
 * bare string literal in an `Exclude` reads as a typo.
 */
export type InlineToolsField = "tools";

/**
 * The "type" `tools` has on every voice arm, so `agent({ tools })` fails with
 * the file to create rather than with a bare excess-property error.
 *
 * A tool is registered by EXISTING: `tools/incident_create.ts` IS the tool
 * `incident_create`, enumerated where the bundle is assembled and named by
 * nothing. The map this replaces restated a rule the filesystem already carried
 * — 62 entries whose whole content was `snake_case_name: camelCaseImport` — and
 * the cost was not the lines, it was that forgetting one was SILENT: the file
 * compiled, lint passed, every gate was green, and the tool never reached the
 * model.
 *
 * Same idiom as {@link PipelineOnlyMisuse}, and for the same reason: the bare
 * error names the field and not what to do about it.
 */
export type InlineToolsMisuse =
  "a tool is declared by its FILE, not here — create `tools/<the name the model calls>.ts` with `export default tool({ … })`, and it is registered by existing";

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
 * (the lesson `mountClient()`'s ComponentTier already recorded).
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
 * The silence-nudge pair, subtracted from the pipeline arm's derived fields so
 * the two can be arbitrated against each other rather than declared
 * independently optional.
 */
export type SilenceNudgeField = "silenceTimeoutMs" | "silencePrompt";

/**
 * The "type" `silencePrompt` has with no `silenceTimeoutMs` beside it.
 *
 * `assertSilencePolicy` has always rejected the pair at config time, so this
 * was caught — at `aai build`, after the author had moved on. It is the same
 * shape as `voice` beside an explicit `tts` (one owner per value) with the
 * arbitration running the other way: the prompt is the timeout's payload, so
 * without the timeout there is no moment at which anything reads it.
 *
 * **This one is a HOVER, not the diagnostic**, unlike every other message in
 * this file. A missing property beats a mistyped one when tsc picks which union
 * arm to report, so what it prints is "Property 'silenceTimeoutMs' is missing …
 * but required in type '{ silenceTimeoutMs: number; silencePrompt?: string }'"
 * — which names the fix, and is the reason the pair is spelled as two arms
 * rather than as a `never`. Arm order does not change it; both were tried.
 */
export type SilencePromptWithoutTimeoutMisuse =
  "`silencePrompt` is the instruction injected when `silenceTimeoutMs` elapses — with no timeout nothing ever injects it; set `silenceTimeoutMs`, or remove `silencePrompt`";

/**
 * The silence nudge: a timeout, and optionally the instruction it injects.
 *
 * Two arms rather than two optional fields, because the prompt alone is a
 * declaration that does nothing.
 */
export type SilenceNudgeParams =
  | {
      /**
       * See {@link AgentDef.silenceTimeoutMs} — how much user silence makes the
       * assistant take a turn.
       */
      silenceTimeoutMs: number;
      /** See {@link AgentDef.silencePrompt} — the instruction that turn injects. */
      silencePrompt?: string;
    }
  | {
      silenceTimeoutMs?: undefined;
      silencePrompt?: SilencePromptWithoutTimeoutMisuse;
    };

/**
 * Pipeline-mode params: any subset of the provider triple (unset stages run
 * on the default all-AssemblyAI pipeline), never `s2s`. The `voice`
 * shorthand picks the default pipeline's TTS voice; an explicit `tts`
 * descriptor owns its voice, so combining the two is a compile error naming
 * the rule.
 *
 * @remarks
 * The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
 * not values this arm accepts. Setting one of those fields makes `tsc` print the
 * sentence in place of a bare excess-property error, so the diagnostic names the
 * rule and what to do about it. Never pass one as a string.
 */
export type PipelineAgentParams = SharedAgentParams &
  Partial<Pick<AgentDef, Exclude<PipelineOnlyField, SilenceNudgeField>>> &
  SilenceNudgeParams & {
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
        /**
         * See {@link AgentDef.stt}. An explicit descriptor owns its own
         * end-of-turn window.
         */
        stt: SttProvider;
        minTurnSilenceMs?: EndpointingOnDescriptorMisuse<"minTurnSilenceMs">;
        maxTurnSilenceMs?: EndpointingOnDescriptorMisuse<"maxTurnSilenceMs">;
      }
    | {
        stt?: undefined;
        /**
         * End-of-turn CHECK window for the default AssemblyAI STT stage, in ms
         * — shorthand for `stt: assemblyAIStt({ minTurnSilenceMs })`, so one
         * knob costs one field rather than a whole stage descriptor.
         *
         * This one taxes EVERY finished utterance, which is why the
         * pause-tolerance knob is `maxTurnSilenceMs` and not this. Read
         * `DEFAULT_MIN_TURN_SILENCE_MS` before moving it; 1600 is a measured
         * knee, and 800 was tried and cost 5.7x on task reward.
         *
         * @defaultValue `1600` (`DEFAULT_MIN_TURN_SILENCE_MS`)
         */
        minTurnSilenceMs?: number;
        /**
         * Pause tolerance for the default AssemblyAI STT stage, in ms —
         * shorthand for `stt: assemblyAIStt({ maxTurnSilenceMs })`.
         *
         * **This is the knob to reach for.** It force-ends a turn regardless of
         * content, so it bounds only utterances that never read as complete:
         * raising it is paid for by hesitant speech alone and costs an ordinary
         * finished sentence nothing. Read `DEFAULT_MAX_TURN_SILENCE_MS`.
         *
         * @defaultValue `3500` (`DEFAULT_MAX_TURN_SILENCE_MS`)
         */
        maxTurnSilenceMs?: number;
      }
  ) &
  (
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
 * pipeline-only tuning knobs typed as `PipelineOnlyMisuse` so setting
 * one fails with a message instead of silently doing nothing.
 *
 * @remarks
 * The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
 * not values this arm accepts. Setting one of those fields makes `tsc` print the
 * sentence in place of a bare excess-property error, so the diagnostic names the
 * rule and what to do about it. Never pass one as a string.
 */
export type S2sAgentParams = SharedAgentParams & {
  /** See {@link AgentDef.s2s} — the explicit opt-in to speech-to-speech mode. */
  s2s: S2sProvider;
  stt?: "`stt` cannot be combined with `s2s` — S2S runs STT service-side";
  llm?: "`llm` cannot be combined with `s2s` — S2S runs the LLM loop service-side";
  tts?: "`tts` cannot be combined with `s2s` — S2S runs TTS service-side";
  voice?: "`voice` is pipeline-mode only — an S2S agent's voice rides on the `s2s` descriptor";
  minTurnSilenceMs?: "`minTurnSilenceMs` tunes a pipeline STT stage — S2S runs STT service-side; remove it or remove `s2s`";
  maxTurnSilenceMs?: "`maxTurnSilenceMs` tunes a pipeline STT stage — S2S runs STT service-side; remove it or remove `s2s`";
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
 * The pipeline-only voice knobs are derived from `PipelineOnlyField`,
 * so a knob added to {@link PipelineVoiceTuning} is rejected here for free.
 *
 * @remarks
 * The long string-literal types on the fields below are COMPILE-ERROR MESSAGES,
 * not values this arm accepts. Setting one of those fields makes `tsc` print the
 * sentence in place of a bare excess-property error, so the diagnostic names the
 * rule and what to do about it. Never pass one as a string.
 */
export type TextAgentParams = Omit<SharedAgentParams, "sttPrompt" | "telephony"> & {
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
  minTurnSilenceMs?: "`minTurnSilenceMs` tunes an STT stage — a text agent has none; remove it or remove `text`";
  maxTurnSilenceMs?: "`maxTurnSilenceMs` tunes an STT stage — a text agent has none; remove it or remove `text`";
  sttPrompt?: "`sttPrompt` biases a transcriber — a text agent has none; remove it or remove `text`";
  telephony?: "`telephony` admits a phone call, which is audio — a text agent has no audio path; remove it or remove `text`";
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
 * The "type" the two endpointing shorthands have alongside an explicit `stt`
 * descriptor, which owns its own end-of-turn window.
 *
 * Same idiom and same rule as `voice` beside an explicit `tts`: the shorthand
 * exists so the COMMON case (the default AssemblyAI stage, one number) costs one
 * field instead of a whole descriptor, and a declaration that already has a
 * descriptor sets it there. One owner per value.
 */
export type EndpointingOnDescriptorMisuse<K extends string> =
  `\`${K}\` tunes the DEFAULT AssemblyAI STT stage — an explicit \`stt\` descriptor owns its own end-of-turn window; set it there (e.g. \`assemblyAIStt({ ${K} })\`) or remove \`stt\``;

/**
 * The workflow-app arm lives in its own module (this file hit the 500-line
 * cap); its four public names are re-exported here so `AgentParams` and the
 * arms an author names stay one import.
 */
export type {
  StaticAgentParams,
  StaticAgentParamsCore,
  WorkflowAppMisuse,
  WorkflowAppOnlyField,
} from "./agent-params-static.ts";
