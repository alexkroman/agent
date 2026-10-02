// Copyright 2026 the AAI authors. MIT license.
/**
 * The author-facing PARAMETER SHAPE of `agent()` — a union discriminated by
 * `mode`, one member per {@link AgentMode}.
 *
 * Every member is CUT from {@link AgentDeclaration} (the authored fields) by
 * subtracting field lists, and carries no prose of its own: what a field means
 * is documented once, on `AgentDeclaration`, and the member says only whether
 * the field exists in that mode.
 * A pipeline-only knob is not typed as an error message on the S2S member — it
 * is ABSENT from it, so `agent({ mode: "s2s", s2s, silence })` is an
 * excess-property error naming {@link S2sAgentParams}, and autocomplete on an
 * S2S agent offers only what an S2S agent has.
 *
 * The field lists below are the single source for both halves of the rule:
 * the members subtract them, and `_agent-modes.ts` refuses the same fields at
 * run time from tables whose `satisfies` makes them total over these types —
 * so a raw `export default {...}`, a JSON config or a spread options bag (none
 * of which the excess-property check sees) meets the same legality.
 */

import type { AgentGuardrails } from "./agent-guardrails.ts";
import type { AgentMode } from "./agent-mode.ts";
import type { AgentModelTuning } from "./agent-model-tuning.ts";
import type { PipelinePhrases, PipelineTuning, TurnTakingTuning } from "./agent-tuning.ts";
import type { LlmSpec } from "./providers/llm/llm.ts";
import type { S2sProvider, SttProvider, TtsProvider } from "./providers.ts";
import type { AgentDeclaration, AgentDef } from "./types.ts";

/** The {@link AgentDef} fields `agent()` fills with defaults when omitted (`tools` is never authored). */
export type DefaultedAgentField = "systemPrompt" | "greeting" | "maxSteps" | "tools";

/**
 * The field a tool USED to be declared with, subtracted from every member so
 * it can be re-typed as {@link InlineToolsMisuse}.
 */
export type InlineToolsField = "tools";

/**
 * The "type" `tools` has on every member, so `agent({ tools })` fails with the
 * file to create rather than with a bare excess-property error.
 *
 * Not a MODE rule — a tool is a file in every mode — which is why it survives
 * the move to a discriminated union: there is no member on which the field
 * exists, so the only thing a discriminant could say about it is "absent", and
 * the absent-field error names the field and not the file to create. A tool is
 * registered by EXISTING: `tools/incident_create.ts` IS the tool
 * `incident_create`, enumerated where the bundle is assembled.
 */
export type InlineToolsMisuse =
  "a tool is declared by its FILE, not here — create `tools/<the name the model calls>.ts` with `export default tool({ … })`, and it is registered by existing";

/**
 * The four provider descriptors. Subtracted from {@link SharedAgentParams} so
 * each member re-declares exactly the ones its mode has.
 */
export type ProviderField = "stt" | "llm" | "tts" | "s2s";

/**
 * Every field only the PIPELINE member has — the STT/TTS stages, the
 * {@link PipelineTuning} groups, the phrases and the guardrails. The three other members subtract it.
 *
 * Derived from the interfaces rather than re-listed, so a group added to
 * `PipelineTuning` is pipeline-only on every other member — and, through the
 * totality of the run-time table, refused there at run time too — without
 * touching this file.
 */
export type PipelineOnlyField =
  | keyof PipelineTuning
  | keyof PipelinePhrases
  | keyof AgentGuardrails
  | "stt"
  | "tts";

/**
 * What every SESSION member shares — pipeline, S2S and text: everything on
 * {@link AgentDeclaration} minus the mode-owned fields, with the defaulted
 * ones optional.
 *
 * The model-loop knobs ({@link AgentModelTuning}) are subtracted here and
 * re-added by the two members whose runtime assembles the model request; S2S
 * runs the model inside the provider's service, so it never has them.
 *
 * @public
 */
export type SharedAgentParams = Omit<
  AgentDeclaration,
  | DefaultedAgentField
  // The mode selector: each member re-declares the value it accepts.
  | "mode"
  | ProviderField
  | PipelineOnlyField
  | keyof AgentModelTuning
> &
  Partial<Pick<AgentDeclaration, Exclude<DefaultedAgentField, InlineToolsField>>> & {
    /** Not a field — see `InlineToolsMisuse`. */
    tools?: InlineToolsMisuse;
  };

/**
 * The PIPELINE member — `mode: "pipeline"`, or no `mode` at all (the default).
 *
 * Any subset of the `stt`/`llm`/`tts` triple; the unset stages run on the
 * default all-AssemblyAI pipeline. The only member with the
 * {@link PipelineTuning} groups, the phrases and the guardrails.
 *
 * @public
 */
export type PipelineAgentParams = SharedAgentParams &
  Pick<
    AgentDeclaration,
    keyof AgentModelTuning | keyof PipelineTuning | keyof PipelinePhrases | keyof AgentGuardrails
  > & {
    /** See {@link AgentDeclaration.mode}. Absent means `"pipeline"`. */
    mode?: "pipeline";
    /**
     * See {@link AgentDeclaration.llm}; a string is gateway model-id shorthand — a bare
     * id for the AssemblyAI LLM Gateway, `"creator/model"` for the Vercel AI
     * Gateway. Typed against the generated catalog so a typo is caught where
     * it is written, and widened by `string & {}` so a newer model compiles.
     */
    llm?: LlmSpec;
    // Present and unsatisfiable, the one `never`-style key a member carries:
    // the S2S descriptor is how the S2S member is SHAPED, and without this key
    // an `{ s2s }` declaration that forgot `mode` would be an extra property
    // this member absorbs when `agent()` resolves against the whole union — a
    // pipeline agent carrying an unused descriptor.
    s2s?: undefined;
    /**
     * See {@link AgentDeclaration.tts}. The voice is the descriptor's own option
     * (`assemblyAITts({ voice: "michael" })`); unset, the default stage
     * speaks `ASSEMBLYAI_TTS_DEFAULT_VOICE`.
     */
    tts?: TtsProvider;
  } & (
    | {
        // An explicit STT descriptor owns its own end-of-turn window, so the
        // `turnTaking.minSilenceMs`/`maxSilenceMs` shorthand is `never` beside
        // one — one owner per value.
        stt: SttProvider;
        turnTaking?: TurnTakingTuning & { minSilenceMs?: never; maxSilenceMs?: never };
      }
    | { stt?: undefined }
  );

/**
 * The S2S member — `mode: "s2s"` and the `s2s` descriptor, and nothing
 * pipeline-shaped: the service runs STT, the model loop and TTS, so the
 * pipeline stages, their tuning and the model-request knobs are all absent.
 *
 * @public
 */
export type S2sAgentParams = SharedAgentParams & {
  /** See {@link AgentDeclaration.mode}. */
  mode: "s2s";
  /** See {@link AgentDeclaration.s2s}. */
  s2s: S2sProvider;
};

/**
 * The TEXT member — `mode: "text"`, optionally an `llm`, and nothing from the
 * audio half of the agent shape.
 *
 * @public
 */
// The fields a text agent drops beyond the pipeline-only ones: `sttPrompt`
// biases a transcriber and `telephony` admits a phone call, and a text agent
// has neither.
export type TextAgentParams = Omit<SharedAgentParams, "sttPrompt" | "telephony"> &
  Pick<AgentDeclaration, keyof AgentModelTuning> & {
    /** See {@link AgentDeclaration.mode}. */
    mode: "text";
    /** See {@link AgentDeclaration.llm}; a model-id string works as on the pipeline member — the one provider stage a text agent has. */
    llm?: LlmSpec;
  };

/**
 * The fields a text agent drops beyond the pipeline-only ones — DERIVED from
 * {@link TextAgentParams}, so the run-time table that `satisfies` a `Record`
 * over it cannot drift from the member.
 */
export type TextOnlyExcludedField = Exclude<keyof SharedAgentParams, keyof TextAgentParams>;

/**
 * The fields a WORKFLOW APP drops beyond what {@link SharedAgentParams} and
 * the text member already subtract: a page over the workflow HTTP API has no
 * session and makes no model request, so nothing reads a system prompt,
 * executes a model-chosen tool, or opens the socket `syncState` pushes over.
 *
 * Only the workflow-app-specific fields: the provider stages, the pipeline
 * knobs and the model-request knobs are already absent from
 * {@link SharedAgentParams}, so a new one is absent from the workflow-app
 * member for free. `description` is deliberately NOT here: a listing wants one
 * whatever the front door is.
 */
export type WorkflowAppOnlyField =
  | "systemPrompt"
  | "voicePresets"
  | "maxSteps"
  | "toolChoice"
  | "builtinTools"
  | "roster"
  | "syncState"
  | "events"
  | "sessionContext"
  | "onSessionEnd"
  | "idleTimeoutMs";

/**
 * The WORKFLOW-APP member — `mode: "workflow-app"`, the workflows that ARE the
 * product, and nothing from the session half of the agent shape.
 * `workflowApp()` is this member with `mode` already set.
 *
 * `workflows` is REQUIRED here, unlike on {@link AgentDeclaration}: a workflow
 * app that declares none serves a form whose every submit is a 400.
 *
 * @public
 */
// The text member's two drops (`sttPrompt`, `telephony`) are spelled as it
// spells them, rather than as `TextOnlyExcludedField`, so the published shape
// reaches no unexported name.
export type WorkflowAppAgentParams = Omit<
  SharedAgentParams,
  "sttPrompt" | "telephony" | WorkflowAppOnlyField | "workflows"
> & {
  /** See {@link AgentDeclaration.mode}. */
  mode: "workflow-app";
  /** See {@link AgentDeclaration.workflows} — the whole product. */
  workflows: NonNullable<AgentDeclaration["workflows"]>;
};

/**
 * What `agent()` returns for a declaration in mode `M`: the one definition
 * type, with `mode` known. Each overload returns its own, so a reader of the
 * result can narrow on the mode it declared without re-deriving it.
 *
 * @public
 */
export type ModeAgentDef<M extends AgentMode> = AgentDef & { readonly mode: M };

/**
 * Everything `agent()` accepts: one member per {@link AgentMode}.
 *
 * @public
 */
export type AgentParams =
  | PipelineAgentParams
  | S2sAgentParams
  | TextAgentParams
  | WorkflowAppAgentParams;
