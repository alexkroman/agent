---
summary: >-
  STT/LLM/TTS/S2S provider descriptors: one defineProvider record per vendor
  and the generated docs table, fallback(), the shipped providers and their rules,
  the AssemblyAI gateway default model and its measurement, voices, adding a
  provider, the stage registries, and the "Session mode resolved" settings log
read_when: >-
  editing a provider descriptor under `packages/aai/src/sdk/providers/`,
  changing a default model or voice, adding a provider, or touching
  `fallback([...])`
---

# packages/aai/src/sdk/providers — provider descriptors

Descriptors here are pure data (no vendor SDK, no `node:`). The OPENERS that
dial them, the resolvers and `_llm-registry.ts` live in `aai-runtime`'s
`providers/`. S2S wire rules: [`S2S-CLAUDE.md`](../../../S2S-CLAUDE.md).

## One registration per vendor, split along the package boundary

**A vendor is ONE
`defineProvider({ kind, stage, envVar, label, factory, subpath })` record here
and ONE opener there**, keyed by `(stage, kind)` (`define-provider.ts` has the
design). The SDK may not import an opener, so the two halves cannot be one call;
everything that is data derives from the record:

- **The factory stamps it** — `describeProvider(DEFINITION, options)`, so a
  factory cannot name a kind of its own; the `*_KIND` / `*_API_KEY_ENV`
  constants on `host-internal` are read off it.
- **`catalog.ts` lists them** (`STT_PROVIDERS`, `TTS_PROVIDERS`,
  `S2S_PROVIDERS`, and `LLM_PROVIDERS`, total over `KnownLlmProvider` by
  `satisfies`); `PROVIDER_CATALOG` is all of them in docs order.
- **`aai-runtime`'s `providers/registry.ts` is the join**: each opener table is
  `{ [K in SttKind]: … }` over the catalog's kinds (a missing or extra opener
  fails `tsc`) and takes `envVar` from the definition; `registry.test.ts` holds
  every registry equal to the catalog at run time. `_llm-registry.ts` holds only
  clients and base URLs.
- **`requiredProviderEnvVars` and the host-credential allowlist read those
  registries**, so neither restates a key.
- **The docs site's provider table is GENERATED** from `PROVIDER_CATALOG` by
  `pnpm sync:provider-table`; `check:provider-table` fails when it is stale. One
  row per key variable; credential-free and `/experimental` providers are left
  out.

## `fallback([...])` — failover as a descriptor

`fallback.ts` (on `/stt`, `/llm` and `/tts`, owned by `aai:stt`) is
`{ kind: "fallback", options: { providers } }`, flattened, at least two members,
the primary's `model` copied up for an LLM's readers. **The policy is on
`fallback`'s doc and nowhere else**: STT/TTS switch on an open failure or an
error before the first output (a transcript / audio); the LLM switches per
REQUEST on a throw or a stream error before the first content part; never on an
abort or after output. The host half is `aai-runtime`'s `providers/fallback.ts`
and `_fallback-llm.ts`; each switch is a `provider.failedOver` session event
(`protocol-events-accounting.ts`), bound per session in
`aai-runtime/src/runtime/transport.ts` because resolution is per runtime.
**Every member's key is required** — the preflight demands them all, and
`resolveLlm` resolves every member eagerly. `agentConfigWarnings` and the
settings log read members one by one.

## STT

`assemblyAIStt({ model: "universal-3-5-pro" })` (`ASSEMBLYAI_API_KEY`),
`deepgramStt({ model: "nova-3" })` (`DEEPGRAM_API_KEY`),
`elevenLabsStt({ model: "scribe_v2_realtime" })` (`ELEVENLABS_API_KEY`;
stage-suffixed so the bare name is free for TTS),
`sonioxStt({ model: "stt-rt-v3" })` (`SONIOX_API_KEY`).

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
the host resolver, never the agent bundle. **Key variables and labels are
`catalog.ts`'s `LLM_PROVIDERS`; base URLs and clients live in `aai-runtime`'s
`providers/_llm-registry.ts`** (`anthropic`, `openai`, `google`, `mistral`,
`xai`, `groq`, `cerebras`, `openrouter`, `gateway`, `assemblyai`). An
UNREGISTERED provider with a `baseUrl` resolves as OpenAI-compatible, keyed by
`apiKeyEnv` (else `<PROVIDER>_API_KEY`). On OpenAI-compatible providers
`providerOptions` is merged into the request BODY by a `fetch` wrapper
(`_request-body-extras.ts`; SDK fields win), because the chat schema strips
vendor keys.

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
- **A candidate default needs a tau2-bench run, not a latency measurement** — it
  is the only default measured on answer quality, and faster models failed more
  (re-asking for mis-heard values). Do not change the default without a per-task
  matched tau2 comparison against the current one.
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

A voice has ONE spelling, the descriptor's option (`assemblyAITts({ voice })`,
`assemblyAIS2s({ voice })`); there is no agent-level `voice`, and the
stray-field check names the descriptor. Its unknown/near-miss warning is
computed once, off the descriptor, by `agentConfigWarnings` (`_nearest-names.ts`
ranks the suggestions, shared with the stray-field check).

## Adding a provider

**STT/TTS/S2S**: the descriptor and its `defineProvider` record in
`{stt,tts,s2s}/<name>.ts`, the record in `catalog.ts`'s stage list, the two
derived constants in `host-internal.ts`, an opener in `aai-runtime`'s
`providers/{stt,tts}/`, and its entry in `providers/registry.ts`'s opener table
(`tsc` refuses the build until it exists). **LLM**: its literal in
`LlmProviderName` and `KNOWN_LLM_PROVIDERS`, a `LLM_PROVIDERS` entry (key
variable, label), and its client in `_llm-registry.ts`'s `LLM_CLIENTS` — each
held total against `KnownLlmProvider`. Then `pnpm sync:provider-table`. A HOST
adds a kind without any of this through `registerSttKind` / `registerTtsKind` /
`registerLlmKind` (`@alexkroman1/aai-runtime`, documented on the docs site's
"Your own provider").

Opener rules (`aai-runtime`'s `providers/_utils.ts`, `_socket.ts`):

- **Use `createSttSessionShell`/`createTtsSessionShell`, not
  `createSessionShell`** — `cleanCloseIsFatal` is per-STAGE.
- **`shell.emit`/`shell.on` are the ONLY path to an opener's emitter** — a
  listener throw from a raw socket handler would crash a multi-tenant host.
- **`openGuardedWs` is the only way to open a raw provider WebSocket** — connect
  deadline (`WS_OPEN_TIMEOUT_MS`, under the session start timeout) and the
  pre-connect `error` guard.
- **All four stages are registries, S2S included**: `S2sKind` is the closed
  union of `S2S_PROVIDERS`' kinds and `aai-runtime/src/runtime/transport.ts`
  switches exhaustively over it; S2S credentials resolve through
  `resolveS2sEnvVar` honouring `apiKeyEnv`, so the preflight and the session
  read the same key.

## Settings, not just kinds

`createRuntime`'s "Session mode resolved" line prints each stage's EFFECTIVE
settings (endpointing, Voice Focus, connect budget, model, `reasoningEffort`,
voice), built by `aai-runtime`'s `providers/_provider-settings.ts` from the SAME
`resolve*Settings` functions here that the openers dial with. **Never write a
second copy of the `??` chains — a settings log that can drift from the wire is
worse than none.** A new provider adds its resolver here and one entry in the
stage table. The four `ASSEMBLYAI_*_KIND` constants are all `"assemblyai"`; the
distinct names exist so `apiKeyEnv` can repoint one stage.
