---
summary: >-
  STT/LLM/TTS/S2S provider descriptors: the shipped providers and their rules,
  the AssemblyAI gateway default model and its measurement, voices, adding a
  provider, the stage registries, and the "Session mode resolved" settings log
read_when: >-
  editing a provider descriptor under `packages/aai/src/sdk/providers/`,
  changing a default model or voice, or adding a provider
---

# packages/aai/src/sdk/providers — provider descriptors

Descriptors here are pure data (no vendor SDK, no `node:`). The OPENERS that
dial them, the resolvers and `_llm-registry.ts` live in `aai-runtime`'s
`providers/`. S2S wire rules: [`S2S-CLAUDE.md`](../../../S2S-CLAUDE.md).

## STT

`assemblyAIStt({ model: "universal-3-5-pro" })` (`ASSEMBLYAI_API_KEY`),
`deepgramStt({ model: "nova-3" })` (`DEEPGRAM_API_KEY`),
`elevenLabsStt({ model: "scribe_v2_realtime" })` (`ELEVENLABS_API_KEY`;
stage-suffixed so the bare name is free for TTS), `sonioxStt({ model:
"stt-rt-v3" })` (`SONIOX_API_KEY`).

- **Never inherit the `assemblyai` SDK's 1000 ms `connectTimeout`** — a healthy
  link blows it and the session dies on `stt_connect_failed`. The opener always
  sets connect timeout/retries/delay from `STT_CONNECT_*`, overridable via
  `assemblyAIStt({ connectTimeoutMs, maxConnectRetries })`. Their shared doc in
  `sdk/pipeline-tuning-constants.ts` carries the sum that must stay under
  `DEFAULT_SESSION_START_TIMEOUT_MS` (asserted in `assemblyai.test.ts`) —
  re-check it before raising any.
- `AssemblyAISttOptions` (`stt/assemblyai.ts`): **`streamingUrl` WINS over
  `region`**, and **unset `languages` means "detect per turn", NOT "English"**.

## LLM

ONE factory, `llm({ provider, model, baseUrl?, apiKeyEnv?, providerOptions? })`
(`llm/llm.ts`), whose `kind` IS the provider. `@ai-sdk/*` is imported only by
the host resolver, never the agent bundle. **Key variables, base URLs and
clients live in `aai-runtime`'s `providers/_llm-registry.ts`** (`anthropic`,
`openai`, `google`, `mistral`, `xai`, `groq`, `cerebras`, `openrouter`,
`gateway`, `assemblyai`). An UNREGISTERED provider with a `baseUrl` resolves as
OpenAI-compatible, keyed by `apiKeyEnv` (else `<PROVIDER>_API_KEY`). On
OpenAI-compatible providers `providerOptions` is merged into the request BODY
by a `fetch` wrapper (`_request-body-extras.ts`; SDK fields win), because the
chat schema strips vendor keys.

**`provider: "assemblyai"`** routes through the AssemblyAI LLM Gateway
(OpenAI-compatible) via `@ai-sdk/openai`'s `.chat()`.
`providerOptions: { region: "eu" }` picks the EU endpoint (`baseUrl` wins);
`reasoningEffort` is consumed by the resolver. Gateway endpoints are on
`/host-internal` because `stepGenerate` dials them. Two stream defects on its
Claude streams are repaired in bytes by `repairOpenAiStream`
(`_openai-stream-repair.ts`); a request defect (Gemini vs zod's
`$schema`/`propertyNames`) is `transformParams` middleware
(`_gateway-tool-schema.ts`). Remove each once the gateway conforms.

### The gateway default model

**`ASSEMBLYAI_LLM_DEFAULT_MODEL` in `llm/assemblyai.ts` is the answer** — don't
trust a prose default (currently `gpt-5.6-luna`).

- **Two things are keyed to the id and fail SILENTLY if wrong** (the constant's
  doc has the matrix): `TOOLS_REQUIRE_NO_REASONING` decides whether
  `llm({ provider: "assemblyai" })` fills `reasoningEffort: "none"`, and
  `assemblyAIPipeline()`'s explicit effort must be one the id ACCEPTS — a
  rejected one surfaces as a bare streamed 500. `"none"` is required on
  `gpt-5.6`, refused by every Gemini id. `define.test.ts` pins the id and the
  preset's effort together.
- **A candidate default needs a tau2-bench run, not a latency measurement** —
  it is the only default measured on answer quality, and faster models failed
  more (re-asking for mis-heard values). Do not change the default without a
  per-task matched tau2 comparison against the current one.
- The generated `gateway-models.ts` cannot carry the reasoning flag
  (`supported_parameters` never lists `reasoning_effort`).

## TTS

`cartesiaTts({ voice })` (`CARTESIA_API_KEY`), `rimeTts({ voice })`
(`RIME_API_KEY`), `assemblyAITts({ voice, language? })` (`ASSEMBLYAI_API_KEY` —
one key for an all-AssemblyAI pipeline).

**`aai-runtime`'s `providers/tts/assemblyai.ts` module doc owns the protocol**:
raw-key auth, not blocking on `Begin`, and **`Generate` only buffers — `Flush`
starts synthesis**. So the adapter buffers host-side and emits
`Generate`+`Flush` **per segment** (a sentence end, or 40 characters —
`splitSegment` in `assemblyai-segment.ts`, whose module doc owns the measured
curve; read it before touching either constant). Invariants:

- only the turn's **last** acknowledgement may emit `done`;
- the end-of-turn flush is never sent empty;
- `sendText` drains **every** segment a delta carries.

## Voices

**`ASSEMBLYAI_TTS_VOICES` in `tts/assemblyai.ts` is the list** — do not restate
it or trust a name absent from it (a wrong id connects, reports ready and stays
silent). Forms read `ttsVoiceIds(language?)` (`/tts`, the non-empty tuple
`z.enum` takes); `ttsVoiceInfo(voice)` is the lookup. **`AssemblyAITtsVoice` is
autocomplete, not a guard**; `assertAssemblyAITtsLanguage` says why only the
language pairing is checked. Both are on the root and `/tts`.

On the default pipeline, `agent({ voice })` desugars to `tts: assemblyAITts({
voice })` (`normalizeAgentConveniences`) and is invalid beside an explicit
`tts`. S2S's voice rides on the `s2s` descriptor; `voice` is a compile error
there.

## Adding a provider

`host-internal.ts` publishes each provider's `KIND` and `<PROVIDER>_API_KEY_ENV`,
never a stage subpath. **STT/TTS/S2S**: descriptor in
`{stt,tts,s2s}/<name>.ts`, its two constants in `host-internal.ts`, an opener in
`aai-runtime`'s `providers/{stt,tts}/`, one entry in `providers/resolve.ts`'s
registry. **LLM**: one `_llm-registry.ts` entry plus its literal in
`LlmProviderName` and `KNOWN_LLM_PROVIDERS` (held together by
`satisfies Record<KnownLlmProvider, …>`).

Opener rules (`aai-runtime`'s `providers/_utils.ts`, `_socket.ts`):

- **Use `createSttSessionShell`/`createTtsSessionShell`, not
  `createSessionShell`** — `cleanCloseIsFatal` is per-STAGE.
- **`shell.emit`/`shell.on` are the ONLY path to an opener's emitter** — a
  listener throw from a raw socket handler would crash a multi-tenant host.
- **`openGuardedWs` is the only way to open a raw provider WebSocket** —
  connect deadline (`WS_OPEN_TIMEOUT_MS`, under the session start timeout) and
  the pre-connect `error` guard.
- **All four stages are registries, S2S included**: `S2sKind` is the closed
  union of `S2S_REGISTRY`'s keys and `runtime-transport.ts` switches
  exhaustively over it; S2S credentials resolve through `resolveS2sEnvVar`
  honouring `apiKeyEnv`, so the preflight and the session read the same key.

## Settings, not just kinds

`createRuntime`'s "Session mode resolved" line prints each stage's EFFECTIVE
settings (endpointing, Voice Focus, connect budget, model, `reasoningEffort`,
voice), built by `aai-runtime`'s `providers/_provider-settings.ts` from the
SAME `resolve*Settings` functions here that the openers dial with. **Never
write a second copy of the `??` chains — a settings log that can drift from the
wire is worse than none.** A new provider adds its resolver here and one entry
in the stage table. The four `ASSEMBLYAI_*_KIND` constants are all
`"assemblyai"`; the distinct names exist so `apiKeyEnv` can repoint one stage.
