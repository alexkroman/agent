// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `defaults` epoch 3.
 *
 * **`DEFAULT_GREETING` narrowed from `string` to its own string literal.** The
 * export list is identical to epoch 2's; what moved is one type. The annotation
 * was redundant — three sibling phrase constants carry none — and it was the
 * reason the reference printed `const DEFAULT_GREETING: string` for the one
 * sentence every caller hears before they say anything, with the source not in
 * the tarball to read it from. `DEFAULT_SILENCE_PROMPT` and
 * `DEFAULT_START_FAILURE_PHRASE` narrowed the same way, by being spelled as one
 * template literal instead of a `+` concatenation; both values are unchanged
 * byte for byte.
 *
 * A literal is assignable to `string`, and a `const` cannot be assigned to, so
 * epoch 2 is RETAINED: `./v2.ts` assigns all three into `Record<string, string>`
 * and compiles unchanged beside this file, which is the evidence.
 *
 * These constants are the published answer to "what happens if I leave this
 * field off", so they are read by callers who need to reproduce a default
 * rather than depend on it — a client sizing a buffer, a harness matching the
 * host's endpointing, a test asserting the shipped value.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
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
  DEFAULT_SILENCE_PROMPT,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_STT_PROMPT,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TOOL_CHOICE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  MAX_DB_RESULT_ROWS,
  MAX_TOOL_RESULT_CHARS,
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
  toolExecutionTimeoutMs: TOOL_EXECUTION_TIMEOUT_MS,
};

/** The caps a client or a tool body has to respect. */
export const limits: Record<string, number> = {
  clientEventNameLength: MAX_CLIENT_EVENT_NAME_LENGTH,
  clientEventPayloadBytes: MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  dbResultRows: MAX_DB_RESULT_ROWS,
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

/**
 * New at epoch 3: the narrowed constants read as VALUES, not as `string`. A
 * caller may now switch on one, or build a union that includes it, without
 * restating the sentence — which is the whole point of dropping the annotation.
 */
export type Greeting = typeof DEFAULT_GREETING;
export const greetingOrCustom = (custom?: string): Greeting | string => custom ?? DEFAULT_GREETING;

/** And they are still assignable everywhere a `string` was expected. */
export const widened: string = DEFAULT_GREETING;
