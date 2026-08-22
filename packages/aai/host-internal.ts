// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/host-internal` — the SDK internals the HOST RUNTIME needs.
 *
 * `@alexkroman1/aai-runtime` is a separate package, so the modules it shares
 * with the SDK have to cross a package boundary. They are not authoring API and
 * carry no semver promise: an `agent.ts` names none of them, and the runtime
 * is the only consumer.
 *
 * Why not `./internal`: that subpath is deliberately ZOD-FREE, and three of
 * these (`EMPTY_PARAMS`, `isConvertibleSchema`, `toToolJsonSchema`) are the
 * schema-conversion helpers, which import zod by construction. Widening
 * `./internal` to fit them would silently delete a documented invariant, so the
 * host support surface gets its own name instead.
 *
 * Like `./internal`, this is on `NON_AUTHORING_SUBPATHS` — no capability, no
 * epoch, and no TypeDoc page.
 */

export {
  asDispatcher,
  type PinnedRequestInit,
  pinnedFetch,
} from "./host/_undici.ts";
export type { RunCodeExecutor } from "./host/builtin-run-code.ts";
export {
  type BuiltinToolOptions,
  type ResolvedBuiltins,
  resolveAllBuiltins,
  resolveBuiltin,
  SANDBOX_ONLY_BUILTINS,
  type ToolDefRecord,
} from "./host/builtin-tools.ts";
export {
  builtinFetch,
  CONTAINED_ENV,
  isPrivateIp,
  resolveAndAssertPublic,
  safeFetch,
  ssrfSafeFetch,
} from "./host/ssrf.ts";
export { EMPTY_PARAMS } from "./sdk/_internal-types.ts";
export { mapStream } from "./sdk/_map-stream.ts";
export { serializeToolFailure } from "./sdk/_tool-failure-wire.ts";
export { RETRYABLE_STATUS } from "./sdk/_upload-retry.ts";
export type {
  ExecuteTool,
  ExecuteToolOptions,
} from "./sdk/agent-config.ts";
export { AGENT_CSP } from "./sdk/agent-csp.ts";
export {
  APP_DB_POOL_MAX,
  APP_DB_PRESENCE_LOCK,
  APP_DB_WORLD_POOL_MAX,
  APP_DB_WORLD_WORKER_CONCURRENCY,
} from "./sdk/app-db-budget.ts";
export {
  CLIENT_AUDIO_LEAD_MS,
  PACER_BURST_MS,
  PLAYBACK_FILL_MS,
} from "./sdk/client-audio-constants.ts";
export { createCoalescingRunner } from "./sdk/coalescing-runner.ts";
export { assertProviderTriple } from "./sdk/config-rules.ts";
export {
  DEFAULT_HOST_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_RELAY_TOOL_TIMEOUT_MS,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_STT_SAMPLE_RATE,
  DEFAULT_TTS_SAMPLE_RATE,
  LOG_PREVIEW_CHARS,
  MAX_CLIENT_WS_BUFFERED_BYTES,
  MAX_CONSECUTIVE_SILENCE_NUDGES,
  MAX_MESSAGE_BUFFER_SIZE,
  MAX_PROVIDER_WS_BUFFERED_BYTES,
  MAX_SESSION_STATE_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  PIPELINE_FLUSH_TIMEOUT_MS,
  S2S_MAX_RESUME_ATTEMPTS,
  SESSION_KEEPALIVE_INTERVAL_MS,
  SESSION_RESUME_GRACE_MS,
  WS_NORMAL_CLOSURE,
  WS_OPEN,
} from "./sdk/constants.ts";
export type {
  AgentEnv,
  HostCredentialEnv,
  ProviderEnv,
} from "./sdk/env-types.ts";
export {
  createEpoch,
  type Epoch,
} from "./sdk/epoch.ts";
export {
  createOwnedMap,
  type OwnedMap,
} from "./sdk/owned-map.ts";
export {
  DEAD_AIR_COVER_MAX_MS,
  DEAD_AIR_COVER_PHRASES,
  DEAD_AIR_OPENING_PHRASE,
  DEFAULT_DEAD_AIR_COVER_MS,
  DEFAULT_FALSE_INTERRUPTION_PROMPT,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_VOICE_FOCUS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  MAX_CONSECUTIVE_FALSE_INTERRUPTION_RESUMES,
  MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE,
  PREEMPTIVE_CONFIDENCE_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
  STT_FRAME_FLOOR_MS,
  STT_FRAME_MAX_MS,
  STT_FRAME_TARGET_MS,
  TAIL_RESUME_MIN_UNHEARD_MS,
  TTS_CANCEL_ACK_TIMEOUT_MS,
  TTS_RECONNECT_TIMEOUT_MS,
} from "./sdk/pipeline-tuning-constants.ts";
export {
  HEARD_AUDIO_LAG_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
} from "./sdk/playback-timing-constants.ts";
export { defaultProviders } from "./sdk/providers/_default-providers.ts";
export { normalizeLlm } from "./sdk/providers/llm/from-string.ts";
export {
  ASSEMBLYAI_STT_DEFAULT_MODEL,
  resolveAssemblyAISttSettings,
} from "./sdk/providers/stt/assemblyai.ts";
export { resolveDeepgramSettings } from "./sdk/providers/stt/deepgram.ts";
export {
  ELEVENLABS_DEFAULT_MODEL,
  resolveElevenLabsSettings,
} from "./sdk/providers/stt/elevenlabs.ts";
export { resolveSonioxSettings } from "./sdk/providers/stt/soniox.ts";
export {
  ASSEMBLYAI_TTS_HOST,
  assemblyAITtsLanguageCodes,
  resolveAssemblyAITtsLanguage,
  resolveAssemblyAITtsSettings,
} from "./sdk/providers/tts/assemblyai.ts";
export { resolveCartesiaSettings } from "./sdk/providers/tts/cartesia.ts";
export {
  RIME_DEFAULT_LANGUAGE,
  RIME_DEFAULT_MODEL,
  resolveRimeSettings,
} from "./sdk/providers/tts/rime.ts";
export {
  makeSttError,
  makeTtsError,
  type SttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type SttTurnMeta,
  type TtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
  type TtsWordTiming,
  type Unsubscribe,
} from "./sdk/providers.ts";
export {
  requestPath,
  requestQuery,
} from "./sdk/request-url.ts";
export { ASSEMBLYAI_S2S_SAMPLE_RATE } from "./sdk/s2s-constants.ts";
export {
  isConvertibleSchema,
  toToolJsonSchema,
} from "./sdk/schema.ts";
export {
  MAX_SESSION_EVENTS,
  SESSION_EVENT_FLUSH_THRESHOLD,
  SESSION_EVENT_READ_LIMIT,
} from "./sdk/session-event-constants.ts";
export {
  createDetachedSlotStore,
  freezeStorable,
} from "./sdk/session-state.ts";
export { sleep } from "./sdk/sleep.ts";
export { formatSchemaIssues } from "./sdk/standard-schema.ts";
export { publishStepEnv } from "./sdk/step-env.ts";
export {
  publishStepFetch,
  type StepFetch,
} from "./sdk/step-fetch.ts";
export {
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} from "./sdk/step-fetch-constants.ts";
export {
  publishStepReporter,
  type StepReporter,
} from "./sdk/step-report.ts";
export {
  publishSpeechSynthesizer,
  SPEECH_UNAVAILABLE_MESSAGE,
  type SpeechSynthesizer,
} from "./sdk/step-speak.ts";
export {
  assertUploadToken,
  publishUploadReader,
  UPLOADS_UNAVAILABLE_MESSAGE,
  type UploadAccess,
  type UploadReader,
  type UploadWriteMeta,
  type UploadWriter,
} from "./sdk/step-uploads.ts";
export { UPLOAD_WRITES_UNAVAILABLE_MESSAGE } from "./sdk/step-uploads-write.ts";
export { buildSystemPrompt } from "./sdk/system-prompt.ts";
export {
  MAX_UPLOAD_BYTES_ENV,
  MAX_WORKFLOW_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  UPLOAD_CLAIM_BATCH,
  UPLOAD_ID_PREFIX,
  UPLOAD_PART_BYTES,
  UPLOAD_TOKEN_RE,
} from "./sdk/upload-constants.ts";
export {
  MISSING_WORKFLOW_ID_MESSAGE,
  PUBLIC_URL_UNCONFIGURED_MESSAGE,
  rejectingWorkflows,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "./sdk/workflow-unavailable.ts";
export { parseWsUpgradeParams } from "./sdk/ws-upgrade.ts";
