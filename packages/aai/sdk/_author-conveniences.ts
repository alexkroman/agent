// Copyright 2026 the AAI authors. MIT license.
/**
 * Normalization of the author-only conveniences `AgentParams` allows on top
 * of `AgentDef` — `system` as an alias of `systemPrompt`, a model-id string
 * for `llm`, and `voice` as shorthand for `tts: assemblyAITts({ voice })`.
 * Used by `agent()` and, for configs that never went through `agent()` (a
 * raw `export default {...}` object), by `toAgentConfig`, so the
 * conveniences work on every authoring path rather than only the
 * documented one.
 *
 * An `_`-internal module (not on the root barrel): this is plumbing between
 * `define.ts` and the config boundary, not API.
 */

import { normalizeLlm } from "./providers/llm/from-string.ts";
import { assemblyAITts } from "./providers/tts/assemblyai.ts";

/**
 * Returns a NEW object (never mutates); non-objects pass through untouched
 * so schema validation still owns the "not an agent config at all" error.
 */
export function normalizeAgentConveniences(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const { system, voice, ...rest } = input as {
    system?: unknown;
    voice?: unknown;
    [key: string]: unknown;
  };
  if (typeof system === "string") {
    if (rest.systemPrompt !== undefined) {
      throw new Error("`system` and `systemPrompt` are aliases — set one, not both.");
    }
    rest.systemPrompt = system;
  }
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
  return rest;
}
