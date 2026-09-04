// Copyright 2026 the AAI authors. MIT license.
/**
 * Normalization of the author-only conveniences `AgentParams` allows on top
 * of `AgentDef` — `system` as an alias of `systemPrompt`, a model-id string
 * for `llm`, `voice` as shorthand for `tts: assemblyAITts({ voice })`, and
 * `minTurnSilenceMs`/`maxTurnSilenceMs` as shorthand for the same two options
 * on `assemblyAIStt()`.
 * Used by `agent()` and, for configs that never went through `agent()` (a
 * raw `export default {...}` object), by `toAgentConfig`, so the
 * conveniences work on every authoring path rather than only the
 * documented one.
 *
 * An `_`-internal module (not on the root barrel): this is plumbing between
 * `define.ts` and the config boundary, not API.
 */

import { assertTurnSilenceWindow, ENDPOINTING_KEYS } from "./config-rules.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { normalizeLlm } from "./providers/llm/from-string.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";
import { assemblyAITts } from "./providers/tts/assemblyai.ts";

/**
 * Returns a NEW object (never mutates); non-objects pass through untouched
 * so schema validation still owns the "not an agent config at all" error.
 */
export function normalizeAgentConveniences(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const { voice, ...rest } = input;
  if (typeof rest.llm === "string") rest.llm = normalizeLlm(rest.llm);
  if (voice !== undefined) {
    if (typeof voice !== "string") {
      throw new Error('`voice` must be a voice-id string (e.g. "jane").');
    }
    if (rest.tts !== undefined) {
      throw new Error(
        "`voice` picks the default pipeline's TTS voice — an explicit `tts` descriptor owns its own voice (e.g. `assemblyAITts({ voice })`); set it there or remove `tts`.",
      );
    }
    if (rest.s2s !== undefined) {
      throw new Error(
        "`voice` is pipeline-mode only — an S2S agent's voice rides on the `s2s` descriptor.",
      );
    }
    // Desugaring would fabricate a `tts` stage, which `assertProviderTriple`
    // then rejects with a message about audio the author never asked for.
    if (rest.text === true) {
      throw new Error("`voice` is pipeline-mode only — a text agent never speaks.");
    }
    rest.tts = assemblyAITts({ voice });
  }
  normalizeEndpointing(rest);
  // AFTER the desugaring, and over `rest.stt` rather than over the two
  // shorthands: the same contradiction is expressible on an explicit
  // `assemblyAIStt({ … })` descriptor, and by the time the shorthand has been
  // lowered onto one there is a single shape to check. Every authoring path
  // runs this function — `agent()` and `toAgentConfig` both — so an inverted
  // window is refused wherever it is written.
  assertTurnSilenceWindow(rest.stt);
  return rest;
}

/**
 * `agent({ minTurnSilenceMs, maxTurnSilenceMs })` → the same two options on the
 * default AssemblyAI STT descriptor, in place.
 *
 * The shorthand exists because these are the highest-value tuning an agent has
 * and were the highest-friction to express: `maxTurnSilenceMs` is the
 * pause-tolerance knob (see `DEFAULT_MAX_TURN_SILENCE_MS`), and reaching it used
 * to mean materializing a whole `assemblyAIStt({ … })` descriptor — which then
 * silently opted the stage out of the default fill, so an author on
 * `assemblyAIPipeline({ region: "eu" })` had to re-declare `region` as well or
 * lose it. One number should not cost a stage.
 *
 * Desugared rather than carried on `AgentDef` so there is ONE owner of the
 * value at runtime — `resolveAssemblyAISttSettings` — instead of a precedence
 * rule between a field and a descriptor. Same reasoning as `voice`, and the
 * same restriction: an explicit `stt` descriptor owns its own window, which the
 * arm types as a compile error (`EndpointingOnDescriptorMisuse`).
 */
function normalizeEndpointing(rest: Record<string, unknown>): void {
  const [minKey, maxKey] = ENDPOINTING_KEYS;
  const min = takeNumber(rest, minKey);
  const max = takeNumber(rest, maxKey);
  if (min === undefined && max === undefined) return;
  const lead = `\`${minKey}\`/\`${maxKey}\` tune the default AssemblyAI STT stage`;
  const owns =
    "an explicit `stt` descriptor owns its own end-of-turn window; set it there " +
    `(e.g. \`assemblyAIStt({ ${maxKey} })\`)`;
  for (const [field, why] of [
    ["stt", owns],
    ["s2s", "S2S runs STT service-side"],
  ] as const) {
    if (rest[field] !== undefined) {
      throw new Error(`${lead} — ${why}, or remove \`${field}\`.`);
    }
  }
  if (rest.text === true) {
    throw new Error(`${lead} — a text agent has none; remove them or remove \`text\`.`);
  }
  rest.stt = assemblyAIStt(omitUndefined({ [minKey]: min, [maxKey]: max }));
}

/** Read a numeric convenience off the params bag and REMOVE it, so `AgentDef` stays canonical. */
function takeNumber(rest: Record<string, unknown>, key: string): number | undefined {
  const value = rest[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`\`${key}\` must be a number of milliseconds.`);
  }
  delete rest[key];
  return value;
}
