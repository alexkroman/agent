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

/**
 * The ffmpeg knobs an OPERATOR sets and a step body never reads.
 *
 * `AAI_FFMPEG_PATH`/`AAI_FFPROBE_PATH` are deployment configuration — where
 * the binaries are on this machine — and the three budgets are what the runner
 * spends when a caller names nothing. A `.d.ts` an agent author imports is the
 * wrong place to publish either; `@alexkroman1/aai/ffmpeg` keeps the four
 * things a step actually calls.
 */
export {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  DEFAULT_MAX_FFMPEG_OUTPUT_BYTES,
  FFMPEG_PATH_ENV,
  FFMPEG_STDERR_TAIL_CHARS,
  FFPROBE_PATH_ENV,
} from "./host/_ffmpeg-spawn.ts";
export { ffmpegVersion } from "./host/_ffmpeg-version.ts";
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
export { APP_DB_POOL_MAX, APP_DB_PRESENCE_LOCK } from "./sdk/app-db-budget.ts";
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
/**
 * The eighteen `*_KIND` / `*_API_KEY_ENV` pairs, one per provider module.
 *
 * They used to sit on the four stage subpaths, and no author ever typed one: a
 * factory returns the `kind`, and the host resolves the credential out of the
 * agent's env by name. Four of the eighteen key names are the same string
 * (`"ASSEMBLYAI_API_KEY"`) under four names, and four of the kinds are
 * (`"assemblyai"`) — the distinct NAMES exist so `apiKeyEnv` can repoint one
 * stage without moving the others, which is a host concern end to end.
 *
 * Here beside the `resolve*Settings` helpers that read them, which is the
 * whole of their readership: the runtime's opener registries, its
 * "Session mode resolved" log, and the platform's credential preflight.
 */
export { ANTHROPIC_API_KEY_ENV, ANTHROPIC_KIND } from "./sdk/providers/llm/anthropic.ts";
export {
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_KIND,
} from "./sdk/providers/llm/assemblyai.ts";
export { normalizeLlm } from "./sdk/providers/llm/from-string.ts";
export { GATEWAY_API_KEY_ENV, GATEWAY_KIND } from "./sdk/providers/llm/gateway.ts";
/**
 * The generated gateway catalog and its row type.
 *
 * The id UNION (`AssemblyAIGatewayModel`) stays on `@alexkroman1/aai/llm`,
 * because `AssemblyAILlmOptions.model` narrows to it. The catalog itself is a
 * 30-row capability table read by the studio's model selection and by this
 * repo's own gate, and inlining it into the published `.d.ts` made a routine
 * regeneration a `major`-classification decision.
 */
export {
  ASSEMBLYAI_GATEWAY_MODELS,
  type GatewayModelInfo,
  gatewayModelIds,
} from "./sdk/providers/llm/gateway-models.ts";
export { GOOGLE_API_KEY_ENV, GOOGLE_KIND } from "./sdk/providers/llm/google.ts";
export { GROQ_API_KEY_ENV, GROQ_KIND } from "./sdk/providers/llm/groq.ts";
export { MISTRAL_API_KEY_ENV, MISTRAL_KIND } from "./sdk/providers/llm/mistral.ts";
export { OPENAI_API_KEY_ENV, OPENAI_KIND } from "./sdk/providers/llm/openai.ts";
export { OPENROUTER_API_KEY_ENV, OPENROUTER_KIND } from "./sdk/providers/llm/openrouter.ts";
export { XAI_API_KEY_ENV, XAI_KIND } from "./sdk/providers/llm/xai.ts";
export {
  ASSEMBLYAI_S2S_API_KEY_ENV,
  ASSEMBLYAI_S2S_KIND,
} from "./sdk/providers/s2s/assemblyai.ts";
export {
  OPENAI_S2S_API_KEY_ENV,
  OPENAI_S2S_KIND,
} from "./sdk/providers/s2s/openai.ts";
export {
  ASSEMBLYAI_STT_API_KEY_ENV,
  ASSEMBLYAI_STT_DEFAULT_MODEL,
  ASSEMBLYAI_STT_KIND,
  resolveAssemblyAISttSettings,
} from "./sdk/providers/stt/assemblyai.ts";
export {
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_KIND,
  resolveDeepgramSttSettings,
} from "./sdk/providers/stt/deepgram.ts";
export {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_KIND,
  resolveElevenLabsSttSettings,
} from "./sdk/providers/stt/elevenlabs.ts";
export {
  resolveSonioxSttSettings,
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
} from "./sdk/providers/stt/soniox.ts";
export {
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_DEPRECATED_VOICES,
  ASSEMBLYAI_TTS_HOST,
  ASSEMBLYAI_TTS_KIND,
  assemblyAITtsLanguageCodes,
  resolveAssemblyAITtsLanguage,
  resolveAssemblyAITtsSettings,
} from "./sdk/providers/tts/assemblyai.ts";
export {
  CARTESIA_API_KEY_ENV,
  CARTESIA_KIND,
  resolveCartesiaTtsSettings,
} from "./sdk/providers/tts/cartesia.ts";
export {
  RIME_API_KEY_ENV,
  RIME_DEFAULT_LANGUAGE,
  RIME_DEFAULT_MODEL,
  RIME_KIND,
  resolveRimeTtsSettings,
} from "./sdk/providers/tts/rime.ts";
export {
  createSttError,
  createTtsError,
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
// The formatter AND the two types beside it. The type was reachable from no
// published subpath at all, so the runtime's eval readers — which validate a
// caller's schema rather than casting the value — had no way to name their own
// parameter. Not authoring API: an author writes `z.object(…)` and never spells
// the spec's interface.
export {
  formatSchemaIssues,
  type StandardSchemaIssue,
  type StandardSchemaV1,
} from "./sdk/standard-schema.ts";
export { publishStepInfoReader, type StepInfoReader } from "./sdk/step-attempt.ts";
export { publishStepEnv } from "./sdk/step-env.ts";
export {
  publishStepFetch,
  type StepFetch,
} from "./sdk/step-fetch.ts";
export {
  STEP_FETCH_CONNECTIONS,
  STEP_FETCH_INACTIVITY_MS,
  STEP_FETCH_KEEP_ALIVE_MS,
  STEP_FETCH_PIPELINING,
} from "./sdk/step-fetch-constants.ts";
export { publishStepReporter, type StepReporter } from "./sdk/step-report.ts";
export {
  publishSpeechSynthesizer,
  SPEECH_UNAVAILABLE_MESSAGE,
  type SpeechSynthesizer,
} from "./sdk/step-speak.ts";
export {
  assertUploadToken,
  type OpenUpload,
  publishUploadReader,
  UPLOADS_UNAVAILABLE_MESSAGE,
  type UploadAccess,
  type UploadReader,
  type UploadWriteMeta,
  type UploadWriter,
} from "./sdk/step-uploads.ts";
export { UPLOAD_WRITES_UNAVAILABLE_MESSAGE } from "./sdk/step-uploads-write.ts";
// The publisher half of a step's webhook URL — the READER (`stepWebhookUrl`) is
// authoring API on `@alexkroman1/aai/step`. Only a host calls this, and it
// publishes a MINTER rather than an origin because the route belongs to whoever
// answers it: `aai-runtime`'s `publishWorkflowWebhookUrl` is the one caller, and
// `sdk/step-webhook.ts` carries why the path may not be spelled a second time
// here. The message is exported for that publisher's own specs.
export {
  publishStepWebhookUrl,
  STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE,
  type StepWebhookMinter,
} from "./sdk/step-webhook.ts";
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
  PUBLIC_URL_UNCONFIGURED_MESSAGE,
  rejectingWorkflows,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "./sdk/workflow-unavailable.ts";
export { parseWsUpgradeParams } from "./sdk/ws-upgrade.ts";
