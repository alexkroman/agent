// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/limits` — every default and budget the SDK reads.
 *
 * Mostly numbers, plus the handful of non-numeric settings that answer the same
 * question ("what does this default to"): `DEFAULT_ERROR_PHRASE`,
 * `DEAD_AIR_COVER_PHRASES`, `DEFAULT_BUILTIN_TOOLS`, `AGENT_CSP`, `WS_OPEN`.
 *
 * A BARREL rather than the `constants.ts` module directly, because the numbers did
 * not all live there: six workflow limits sat in `workflow-limits.ts` (split off
 * `workflow.ts` at the file-length cap), and `MAX_DB_RESULT_ROWS` /
 * `MAX_SLUG_LENGTH` sit with the contracts they bound. A subpath whose name
 * promises "the limits" and delivers 88 of 96 is worse than no subpath: the eight
 * it omits are the ones an author reaches for after reading a durability error.
 * Moving them instead would put them all in one file that is already at the
 * file-length cap, and separate each from the doc comment explaining what it
 * bounds.
 *
 * Named re-exports rather than `export *`, for the reason every other barrel here
 * gives (`runtime-barrel.ts`, `stt-barrel.ts`): the wildcard form needs a
 * `noReExportAll` suppression, and `pnpm check:hatches` only ratchets down. It
 * also makes this subpath's surface deliberate — a new constant in
 * `constants.ts` does not become public API until it is listed here.
 *
 * @module limits
 */

export {
  AGENT_CSP,
  AGENT_FAVICON,
  ASSEMBLYAI_S2S_SAMPLE_RATE,
  CAPTURE_STOP_ACK_TIMEOUT_MS,
  CLIENT_AUDIO_LEAD_MS,
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_DEAD_AIR_COVER_MS,
  DEFAULT_ERROR_PHRASE,
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_RELAY_TOOL_TIMEOUT_MS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_SILENCE_PROMPT,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_STT_PROMPT,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TOOL_CHOICE,
  DEFAULT_TTS_SAMPLE_RATE,
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  FETCH_TIMEOUT_MS,
  HEARD_AUDIO_LAG_MS,
  HTML_ACCEPT,
  LOG_PREVIEW_CHARS,
  MAX_AUDIO_SAMPLE_RATE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  MAX_CLIENT_WS_BUFFERED_BYTES,
  MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
  MAX_CONSECUTIVE_SILENCE_NUDGES,
  MAX_DESIGN_CSS_CHARS,
  MAX_DESIGN_HTML_CHARS,
  MAX_DESIGN_STYLESHEETS,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_HTML_BYTES,
  MAX_JSON_BYTES,
  MAX_MESSAGE_BUFFER_SIZE,
  MAX_PAGE_CHARS,
  MAX_PLAYBACK_BUFFERED_MS,
  MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE,
  MAX_PROVIDER_WS_BUFFERED_BYTES,
  MAX_TOOL_RESULT_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MAX_WS_PAYLOAD_BYTES,
  MIC_BUFFER_SECONDS,
  MIC_SEND_MAX_BUFFERED_BYTES,
  MIC_SILENCE_PROBE_MS,
  PACER_BURST_MS,
  PIPELINE_FLUSH_TIMEOUT_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
  PLAYBACK_BUFFER_SECONDS,
  PLAYBACK_CONCEAL_FADE_MS,
  PLAYBACK_CONCEAL_FLOOR,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  PLAYBACK_JITTER_MS,
  PLAYBACK_PROGRESS_INTERVAL_MS,
  PLAYBACK_REFILL_MS,
  PREEMPTIVE_CONFIDENCE_THRESHOLD,
  S2S_MAX_RESUME_ATTEMPTS,
  SESSION_KEEPALIVE_INTERVAL_MS,
  SESSION_RESUME_GRACE_MS,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
  STT_FRAME_FLOOR_MS,
  STT_FRAME_MAX_MS,
  STT_FRAME_TARGET_MS,
  TAIL_RESUME_MIN_UNHEARD_MS,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_RESULT_TRUNCATION_MARKER,
  TOOL_USER_AGENT,
  TTS_COALESCE_MAX_CHARS,
  TTS_RECONNECT_TIMEOUT_MS,
  WS_NORMAL_CLOSURE,
  WS_OPEN,
} from "./constants.ts";
export { MAX_DB_RESULT_ROWS } from "./db.ts";
export { MAX_SLUG_LENGTH } from "./slug.ts";
export {
  DEFAULT_STEP_BACKOFF_MS,
  DEFAULT_STEP_MAX_ATTEMPTS,
  DEFAULT_WORKFLOW_FIND_LIMIT,
  MAX_CONTINUATIONS,
  MAX_WORKFLOW_FIND_LIMIT,
  MAX_WORKFLOW_STEPS,
} from "./workflow-limits.ts";
