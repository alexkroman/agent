// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `defaults` epoch 1.
 *
 * These constants are the published answer to "what happens if I leave this
 * field off", so they are read by callers who need to reproduce a default
 * rather than depend on it — a client sizing a buffer, a harness matching the
 * host's endpointing, a test asserting the shipped value.
 *
 * A changed VALUE does not move the report (the type is unchanged), which is
 * exactly why they are their own capability: the epoch pins the SHAPE, and this
 * fixture pins that each one is still reachable and still the type a caller
 * arithmetic'd against.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  type BuiltinTool,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_ERROR_PHRASE,
  DEFAULT_GREETING,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_SILENCE_PROMPT,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_STT_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOL_CHOICE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  MAX_DB_RESULT_ROWS,
  MAX_PLAYBACK_BUFFERED_MS,
  MAX_TOOL_RESULT_CHARS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
  STORAGE_DISABLED_MESSAGE,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_RESULT_TRUNCATION_MARKER,
  type ToolChoice,
} from "../../../index.ts";

/** The numeric budgets, all usable in arithmetic. */
export const timings: Record<string, number> = {
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  interruptionMinDurationMs: DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  maxHistory: DEFAULT_MAX_HISTORY,
  maxSteps: DEFAULT_MAX_STEPS,
  maxTurnSilenceMs: DEFAULT_MAX_TURN_SILENCE_MS,
  minBargeInWords: DEFAULT_MIN_BARGE_IN_WORDS,
  minTurnSilenceMs: DEFAULT_MIN_TURN_SILENCE_MS,
  sessionStartTimeoutMs: DEFAULT_SESSION_START_TIMEOUT_MS,
  playbackProgressIntervalMs: PLAYBACK_PROGRESS_INTERVAL_MS,
  toolExecutionTimeoutMs: TOOL_EXECUTION_TIMEOUT_MS,
};

/** The caps a client or a tool body has to respect. */
export const limits: Record<string, number> = {
  clientEventNameLength: MAX_CLIENT_EVENT_NAME_LENGTH,
  clientEventPayloadBytes: MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  dbResultRows: MAX_DB_RESULT_ROWS,
  playbackBufferedMs: MAX_PLAYBACK_BUFFERED_MS,
  toolResultChars: MAX_TOOL_RESULT_CHARS,
};

/** The spoken and written strings. */
export const phrases: Record<string, string> = {
  errorPhrase: DEFAULT_ERROR_PHRASE,
  greeting: DEFAULT_GREETING,
  silencePrompt: DEFAULT_SILENCE_PROMPT,
  startFailurePhrase: DEFAULT_START_FAILURE_PHRASE,
  sttPrompt: DEFAULT_STT_PROMPT,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  storageDisabled: STORAGE_DISABLED_MESSAGE,
  truncationMarker: TOOL_RESULT_TRUNCATION_MARKER,
};

/** The two that carry a narrowed type rather than a primitive. */
export const toolChoice: ToolChoice = DEFAULT_TOOL_CHOICE;
export const builtinTools: readonly BuiltinTool[] = DEFAULT_BUILTIN_TOOLS;

/** A caller reproducing the host's truncation rule. */
export function truncateResult(result: string): string {
  return result.length <= MAX_TOOL_RESULT_CHARS
    ? result
    : `${result.slice(0, MAX_TOOL_RESULT_CHARS)}${TOOL_RESULT_TRUNCATION_MARKER}`;
}
