// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `defaults`.
 *
 * The documented defaults and limits. Each one is the published answer to
 * "what happens if I leave this field off", so a changed VALUE is a behaviour
 * change for every agent that omitted the field — which is why they are a
 * capability rather than trivia.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
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
} from "../../index.ts";
