// Copyright 2026 the AAI authors. MIT license.
/**
 * The per-STATE voice knobs a `dialog()` declares, as the PIPELINE applies them.
 *
 * A dialog state may declare five (see `DialogVoiceConfig`). Three of them reach
 * this module and two never do, and the split is a property of where each
 * setting is fixed rather than a decision anyone made here:
 *
 * | Knob | Where it takes effect | Per state? |
 * | --- | --- | --- |
 * | `bargeIn` | the two interim gates in `pipeline-user-speech.ts`, read at the moment a partial is classified | yes |
 * | `toolChoice` | the `streamText` request | yes, per STEP |
 * | `temperature` | the `streamText` request | yes, per STEP |
 * | `voice` | `TtsOpenOptions` — the voice is baked into the DESCRIPTOR that produced the opener, and the open happens once per session | **no** |
 * | `keyterms` | `SttOpenOptions` — which has no keyterms field at all; only the AssemblyAI S2S service takes them, in `session.update` | **no** |
 *
 * The last two are refused where an author can see it rather than dropped here —
 * see `reportDialogKnobs` in `runtime-dialog-knobs.ts`, which warns naming the
 * state and the knob. A knob that silently does nothing is worse than one that
 * is absent, and "the TTS voice changes mid-disclosure" is exactly the claim a
 * reader would believe on finding the field accepted.
 *
 * ## Per STEP, not per turn
 *
 * `toolChoice` and `temperature` arrive as a `prepareStep` preparer rather than
 * as request fields, and that is the stronger place: a gated tool can move the
 * dialog in the MIDDLE of a turn, so the step after it is already in the next
 * state and should run under the next state's knobs. Composed BEFORE
 * `forceFinalAnswer`, which keeps its override of `toolChoice` on the reserved
 * answering step — a state pinning a tool must not un-reserve the one step that
 * exists so the model has no move left but to speak.
 *
 * ## And AFTER the agent-scoped reset, which is the same rule from the other end
 *
 * `resetToolChoiceAfterFirstStep` puts a DEMANDING agent-level `toolChoice`
 * back to `"auto"` once the first step has run, and it shares this preparer's
 * one key. `ToolChoice`'s scope list puts the dialog state above the agent, so
 * the reset is composed first and this preparer overwrites it — see the
 * `prepareStep` composition in `pipeline-llm-stream.ts`, which spells the whole
 * order out. Composed the other way round the reset won from step 1 on, and a
 * state's pin quietly stopped applying after the first step of every turn on
 * any agent that declares a demanding `toolChoice` of its own.
 */

import type { ToolChoice } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { PrepareStepFunction, ToolSet } from "ai";

/**
 * What the active dialog state asks of THIS turn, in the transport's own units.
 *
 * `bargeIn` is already translated: this type carries the two numbers the gates
 * read, not the SDK's `DialogBargeIn`, because the translation ("off" means an
 * unreachable word threshold) is a fact about these gates and belongs on this
 * side of the seam. Every field is optional and an absent one means "leave the
 * agent's own setting alone" — a state that declares two knobs must not reset
 * the other three to their defaults.
 *
 * @internal
 */
export interface DialogTurnKnobs {
  /** Interim words required to barge in. `Infinity` is `bargeIn: "off"`. */
  minBargeInWords?: number | undefined;
  /** Sustained-speech gate for an interim-triggered barge-in; 0 disables it. */
  interruptionMinDurationMs?: number | undefined;
  /** Tool-selection policy for the steps taken while this state is active. */
  toolChoice?: ToolChoice | undefined;
  /** Sampling temperature for the steps taken while this state is active. */
  temperature?: number | undefined;
}

/**
 * Where the transport reads them from: a thunk, resolved fresh at each read.
 *
 * A THUNK and not a value, for the reason the system prompt is one — the
 * conversation moves between reads, and a value captured at transport
 * construction would pin the whole call to whatever state the first turn started
 * in. `undefined` from the thunk means no dialog declares anything here right
 * now, which is the ordinary case even on an agent that declares knobs
 * elsewhere.
 *
 * @internal
 */
export type DialogTurnSource = () => DialogTurnKnobs | undefined;

/** The three live knobs, in the shapes the transport's consumers want. @internal */
export interface PipelineDialogKnobs {
  /** For `createUserActivity` — read at the moment a partial is classified. */
  minBargeInWords: () => number;
  /** For `createUserActivity` — the duration gate beside it. */
  interruptionMinDurationMs: () => number;
  /**
   * For `startLlmStream`, or `undefined` when no dialog declares an LLM knob.
   *
   * The `undefined` is load-bearing twice over: it keeps a dialog that declares
   * only instructions and deadlines from putting a preparer in front of every
   * step, and it is what the transport gates PREEMPTIVE GENERATION on — see
   * `pipeline-transport.ts`.
   */
  dialogStep: PrepareStepFunction<ToolSet> | undefined;
}

/**
 * Bind a session's dialog knobs to the pipeline's defaults.
 *
 * `base` is what the AGENT declared (`agentConfig.minBargeInWords` and friends,
 * already defaulted by `resolvePipelineOptions`), and every read falls back to
 * it: a dialog overrides the states it has an opinion about and nothing else.
 * With no source at all the returned thunks are constant, so a session without
 * dialogs pays one closure call per classification and no dialog machinery.
 *
 * @internal
 */
export function createDialogKnobs(
  source: DialogTurnSource | undefined,
  base: { minBargeInWords: number; interruptionMinDurationMs: number },
): PipelineDialogKnobs {
  if (source === undefined) {
    return {
      minBargeInWords: () => base.minBargeInWords,
      interruptionMinDurationMs: () => base.interruptionMinDurationMs,
      dialogStep: undefined,
    };
  }
  return {
    minBargeInWords: () => source()?.minBargeInWords ?? base.minBargeInWords,
    interruptionMinDurationMs: () =>
      source()?.interruptionMinDurationMs ?? base.interruptionMinDurationMs,
    // `undefined` rather than `{}` when the active state declares neither, so a
    // step the dialog has nothing to say about is prepared by exactly the
    // preparers that shipped before this existed. `composePrepareStep` treats an
    // empty result as "no keys", so both are correct — but only one of them says
    // so at the call site.
    dialogStep: () => {
      const knobs = source();
      const step = omitUndefined({
        toolChoice: knobs?.toolChoice,
        temperature: knobs?.temperature,
      });
      return Object.keys(step).length === 0 ? undefined : step;
    },
  };
}
