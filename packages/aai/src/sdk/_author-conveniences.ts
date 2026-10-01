// Copyright 2026 the AAI authors. MIT license.
/**
 * Normalization of what an author WRITES into the canonical `AgentDef` shape:
 * the mode, the field legality that follows from it, and the author-only
 * conveniences.
 *
 * In order, because each step reads what the one before it settled:
 *
 * 1. **The mode** (`resolveAgentMode`, `_agent-modes.ts`) — `mode`, or the
 *    pipeline default, written onto the definition.
 * 2. **Field legality** (`assertModeFields`) — every field the mode's member
 *    does not have, refused by name. Against the AUTHORED fields, so `voice` on
 *    an S2S agent is reported as `voice`.
 * 3. **The conveniences** — a model-id string for `llm`, `voice` as shorthand
 *    for `tts: assemblyAITts({ voice })`, and `minTurnSilenceMs`/
 *    `maxTurnSilenceMs` as shorthand for the same two options on
 *    `assemblyAIStt()`.
 *
 * **There is no `system` alias.** `agent({ system: "…" })` reaches
 * `assertNoStrayFields` and is refused BY NAME, which is the better error: two
 * spellings of one field is a precedence rule somebody has to remember.
 *
 * Used by `agent()` and, for configs that never went through `agent()` (a raw
 * `export default {...}` object), by `toAgentConfig` — and idempotent, because
 * `toAgentConfig` also sees `agent()`'s own output.
 *
 * An `_`-internal module (not on the root barrel): plumbing between
 * `define.ts` and the config boundary, not API.
 */

import { assertModeFields, resolveAgentMode } from "./_agent-modes.ts";
import { assertTurnSilenceWindow, ENDPOINTING_KEYS } from "./config-rules.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { normalizeLlm } from "./providers/llm/shared/from-string.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";
import { assemblyAITts } from "./providers/tts/assemblyai.ts";

/**
 * Returns a NEW object (never mutates); non-objects pass through untouched
 * so schema validation still owns the "not an agent config at all" error.
 */
export function normalizeAgentParams(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const rest: Record<string, unknown> = { ...input };
  const mode = resolveAgentMode(rest);
  assertModeFields(mode, rest);
  rest.mode = mode;
  if (typeof rest.llm === "string") rest.llm = normalizeLlm(rest.llm);
  lowerVoice(rest);
  normalizeEndpointing(rest);
  // AFTER the desugaring, and over `rest.stt` rather than over the two
  // shorthands: the same contradiction is expressible on an explicit
  // `assemblyAIStt({ … })` descriptor, and by the time the shorthand has been
  // lowered onto one there is a single shape to check.
  assertTurnSilenceWindow(rest.stt);
  return rest;
}

/**
 * `agent({ voice })` → `tts: assemblyAITts({ voice })`, in place. Which modes
 * may carry `voice` at all is `assertModeFields`' question, already answered.
 */
function lowerVoice(rest: Record<string, unknown>): void {
  const { voice } = rest;
  if (voice === undefined) return;
  delete rest.voice;
  if (typeof voice !== "string") {
    throw new Error('`voice` must be a voice-id string (e.g. "jane").');
  }
  if (rest.tts !== undefined) {
    throw new Error(
      "`voice` picks the default pipeline's TTS voice — an explicit `tts` descriptor owns its own voice (e.g. `assemblyAITts({ voice })`); set it there or remove `tts`.",
    );
  }
  rest.tts = assemblyAITts({ voice });
}

/**
 * `agent({ minTurnSilenceMs, maxTurnSilenceMs })` → the same two options on the
 * default AssemblyAI STT descriptor, in place.
 *
 * The shorthand exists because these are the highest-value tuning an agent has
 * and were the highest-friction to express: reaching `maxTurnSilenceMs` used to
 * mean materializing a whole `assemblyAIStt({ … })` descriptor — which then
 * silently opted the stage out of the default fill. One number should not cost
 * a stage. Desugared rather than carried on `AgentDef` so there is ONE owner of
 * the value at runtime — `resolveAssemblyAISttSettings`.
 */
function normalizeEndpointing(rest: Record<string, unknown>): void {
  const [minKey, maxKey] = ENDPOINTING_KEYS;
  const min = takeNumber(rest, minKey);
  const max = takeNumber(rest, maxKey);
  if (min === undefined && max === undefined) return;
  if (rest.stt !== undefined) {
    throw new Error(
      `\`${minKey}\`/\`${maxKey}\` tune the default AssemblyAI STT stage — an explicit \`stt\` ` +
        "descriptor owns its own end-of-turn window; set it there " +
        `(e.g. \`assemblyAIStt({ ${maxKey} })\`), or remove \`stt\`.`,
    );
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
