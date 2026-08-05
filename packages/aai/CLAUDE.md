# @alexkroman1/aai — shared core SDK

The agent config, types, protocol, providers, session, and runtime that every
other package builds on. Repo-wide commands, conventions, and the package map
live in the root [CLAUDE.md](../../CLAUDE.md); the platform that runs these
agents is documented in [aai-server](../aai-server/CLAUDE.md).

## SDK structure

The SDK is organized into two directories with a **hard dependency
boundary** — this split is critical for sandbox security:

- **`sdk/`** — shared modules with **zero Node.js dependencies**. Safe to
  run in browsers, Deno, and sandboxed environments. Contains:
  `types.ts`, `db.ts`, `hooks.ts`, `utils.ts`, `constants.ts`,
  `protocol.ts`, `system-prompt.ts`,
  `ws-upgrade.ts`, `_internal-types.ts`, `agent-config.ts` (the canonical
  serializable config + `toAgentConfig`), `schema.ts` (Standard Schema
  acceptance: `inputSchema` validation + JSON Schema conversion),
  `define.ts` (`agent()` and `tool()` helpers for authoring `agent.ts`
  files).
- **`host/`** — host-only modules that **require Node.js APIs** (`node:vm`,
  `node:crypto`, etc.). Only runs on the platform server and CLI, never
  inside a guest sandbox. Contains:
  `server.ts`, `runtime.ts`, `runtime-config.ts`, `runtime-types.ts`,
  `runtime-transport.ts` (transport selection/construction for the runtime),
  `tool-executor.ts`, `session-core.ts`, `s2s.ts`, `ws-handler.ts`,
  `transports/` (S2S / pipeline / OpenAI Realtime `Transport`
  implementations, including `pipeline-turn-outcome.ts` — the three ways a
  pipeline turn ends: interrupted by barge-in, failed, or spoken), `to-vercel-tools.ts`,
  `providers/` (STT/TTS openers + descriptor→instance resolvers),
  `builtin-tools.ts`, `postgres-db.ts`.

**Rule**: When adding new SDK code, place it in `sdk/` if it has no
`node:` dependencies. Moving code from `sdk/` → `host/` is safe;
moving `host/` → `sdk/` requires removing all Node.js imports first.

The guest harness (`packages/aai-guest/harness.ts`) runs **Node** inside each Modal
Sandbox — the same runtime as the host and `aai dev` — loading the agent's
ESM bundle directly; the Modal sandbox (not a language runtime permission
model) is the security boundary.

## `ctx.generate` (one-shot LLM generation)

Tool `execute` code gets one-shot LLM generation via `ctx.generate` — a
**runtime capability like `ctx.db`**. One implementation,
`createGenerateFn` (`host/generate.ts`, exported from `/runtime`), runs
wherever the runtime runs — inside the guest sandbox on the platform,
in-process under `aai dev`: descriptors resolve through the same
`resolveLlm` registry as the pipeline model, credentials from the agent env
only. Defaults to the agent's own pipeline `llm`; a per-call `llm`
descriptor (or model-id string — same shorthand as `agent({ llm })`) works
for S2S agents holding that provider's key.

`GenerateOptions.schema` accepts a Zod schema directly (or any Standard
Schema convertible to JSON Schema — `sdk/schema.ts` owns detection and
conversion), converted before the provider call; a plain JSON Schema object
also works. `GenerateFn` is generic, so a Standard Schema call returns a
typed `object`. Note zod 4.4 stamps `~standard` onto its plain
`toJSONSchema()` OUTPUT too — schema detection keys off the `_zod` instance
marker, never the `~standard` interface (`isConvertibleSchema`).
(The pattern-combinator layer that once wrapped this —
`@alexkroman1/aai/patterns`, earlier `@alexkroman1/aai/workflow` — was
removed unused; multi-step orchestration is composed directly over
`ctx.generate`.)

## Session modes

Each agent runs in one of two session modes, selected by `toAgentConfig()`
(run in the generated bundle entry) based on which top-level fields are
present in the `agent()` config:

- **Pipeline mode** (the DEFAULT — all three of `stt`, `llm`, and `tts`
  set, or none of the four provider fields set, in which case the
  all-AssemblyAI pipeline (`assemblyAIPipeline()`) is injected by
  `defaultProviders` in `sdk/providers/_default-providers.ts`) uses
  `createPipelineTransport()` in
  `packages/aai/host/transports/pipeline-transport.ts`. Here the host
  drives the LLM loop itself via the Vercel AI SDK's `streamText`, and STT
  and TTS are pluggable providers imported from the `@alexkroman1/aai/stt`
  and `@alexkroman1/aai/tts` subpath exports.
- **S2S mode** (explicit opt-in — `s2s: assemblyAIS2s()` from the main
  export, or `openaiRealtime()` from `@alexkroman1/aai/s2s`) uses
  `createS2sTransport()` in `packages/aai/host/transports/s2s-transport.ts`.
  The host opens a single WebSocket to AssemblyAI's speech-to-speech
  service; STT, the LLM loop, and TTS all run service-side and audio/events
  relay through that one socket. This is the original architecture, and was
  the implicit default before the pipeline-by-default flip. There is no way
  to reach S2S by omission — only the `s2s` descriptor selects it.

  **S2S has no agent captions on tool-call turns, and this is not our bug.**
  Measured against the live service (2026-08-03) with a standalone WebSocket
  client, no SDK in the path: `transcript.agent` is emitted for every non-tool
  reply with a matching `reply_id`, and for NEITHER reply of a tool-call turn —
  not the one carrying `tool.call`, not the one after `tool.result`. Declaring
  tools changes nothing; calling one does. So a tool-using agent renders blank
  reply text for exactly the turns that do the work, `reply.done` logs
  `agentText: "none"`, and `replyAnomaly` warns "delivered audio with no
  transcript" once per tool turn. There is no client-side remedy —
  `transcript.agent` is the only event in the protocol carrying agent text.
  Anything reading reply text (history, evals, a tau2-style harness scoring
  what the agent *said*) sees silence for a turn the user heard answered.

  Two traps here. The docs contradict each other on whether it is intended:
  the canonical message-sequence page shows `transcript.agent` inside its
  `opt tool call` branch and calls it "Per agent reply", while the
  execution-modes page's `interactive` diagram shows neither tool-turn reply
  emitting it — the service matches the latter. And
  `transcript.agent.delta` is documented in the events reference but **is not
  implemented**: zero frames arrive even for a plain greeting reply that does
  send `transcript.agent`, and it appears nowhere on the canonical page. An
  accumulator for it was added (#a42cdbd3) and removed again once measurement
  showed it could never fire; do not re-add one on the strength of the docs.

The default injection runs at every mode-derivation site — `toAgentConfig`
(so it is baked into deployed configs at build time) and `createRuntime`'s
provider resolution — before `assertProviderTriple`.
Partial provider configs are FILLED, not rejected: `defaultProviders`
supplies the AssemblyAI default for each unset stage of `stt`/`llm`/`tts`
(when `s2s` is unset), so `agent({ llm: anthropic(...) })` means "the
default pipeline with that LLM". The compile-time union (`AgentParams` in
`sdk/define.ts`) matches: any subset of the triple is legal, while `s2s`
combined with a pipeline provider or a pipeline-only tuning field still
fails `tsc` with a message naming the rule (`PipelineOnlyMisuse`) instead
of silently no-opping. `assertProviderTriple`'s partial-triple error now
only guards raw wire shapes that skipped the fill.

- **Tool-call args must be coerced before they hit a wire schema.** The AI
  SDK surfaces an unparsable/unknown tool call as a `tool-call` stream part
  whose `input` is the *raw argument string*, not a parsed object. The
  WebSocket `tool_call` event requires a record for `args`, so every emitter
  routes args through `toArgsRecord` (`sdk/utils.ts`; non-records become
  `{}`), and a failed/invalid call is recorded with an error `result` rather
  than left dangling.

- **The capture worklet** (`worklets/capture-processor.ts`) is the single
  mic-capture processor. It flushes a `slice()` copy and keeps its own
  buffer (re-reading a just-transferred view is how a mic once went
  permanently deaf), with start/stop gating, a stop → flush → `stopped`-ack
  protocol, and the dead-mic probe. Two guards remain load-bearing:
  `instantiateWorklet`'s harness honors the transfer list (`structuredClone`
  with `transfer`, which really detaches) and caps posted messages so a
  runaway loop is a named failure rather than a hang, and
  `worklets/capture-processor.test.ts` exercises the processor source.

- **Pre-connection client config**: the default client page is
  byte-identical for every agent and the CSP bars inline scripts, so the
  agent's display name and greeting reach the browser via a pre-connection
  endpoint: `GET /client-config` (dev server) / `GET /:slug/client-config`
  (platform, unauthenticated — parity with the page and the WebSocket)
  returns `{ name, greeting }` (`sdk/client-config.ts`, re-exported from
  `/protocol`). **Every server builds the body through one helper**,
  `buildClientConfig`; the platform's handler lives in
  `aai-server/client-config-handler.ts` — and on the platform name/greeting
  are PROXIED from the GUEST'S own `/client-config` (the bundle's live
  agent definition; the harness passes the loaded agent's name/greeting to
  `createServer`), never read from the stored config, which is fully opaque
  to the host. A guest that can't answer degrades to `{ sessionUrl }` only.
  In `aai-ui`, `client()`'s config
  tier renders `DefaultRoot`, which fetches the config (any failure degrades
  to the empty default, so older servers keep working) and mounts the chat
  shell; the shell uses the server-declared `name` unless `client({ name })`
  overrides it. A custom `component` ignores all of it. The `aai dev` Vite
  proxy forwards `/client-config` to the backend.

  **The session's per-attempt broker lookup uses `loadClientConfig`, not
  `fetchClientConfig`** — it returns `null` for a lookup that produced no
  answer, keeping that distinct from a server that answered and named no
  `sessionUrl`. Degrading both to `{}` is fine for name/greeting and wrong
  here: `session-core.ts` latches `serverIsBroker = false` on a config with
  no `sessionUrl`, and that latch skips the broker fetch on every later
  attempt. So one 503 — a sandbox mid-boot, or one that failed to start —
  pinned the client to the platform's `/:slug/websocket`, whose WebSocket
  redirect browsers do not follow (sessions go straight to the sandbox now),
  with no route back even after the agent recovered. Only an ANSWERED lookup
  may set the latch.

- **There is no text-only mode.** Every pipeline agent declares a real TTS
  provider, and the default `ChatView` always renders the voice `Controls`.
  The snapshot's `apiUrl` field carries the programmatic WebSocket endpoint,
  shown by `ApiUrlChip`. **It is the LONG-LIVING platform endpoint**
  (`wss://host/:slug/websocket`), never the brokered sandbox tunnel URL the
  session actually connects to — the tunnel URL dies with the sandbox (idle
  eviction, redeploy), so surfacing it hands users a link that rots. The
  platform endpoint stays valid: a plain upgrade on it resolves the live
  sandbox (booting it like the client-config broker) and answers a 302
  redirect to the sandbox's current session URL (`orchestrator-ws.ts`,
  query preserved so `?sessionId=` resumes survive). Programmatic WebSocket
  clients that follow handshake redirects land on the sandbox; browsers
  don't follow WebSocket redirects, which is fine — the browser path is the
  client-config broker.

Reference providers shipped today:

- **STT**: one of
  - `assemblyAIStt({ model: "universal-3-5-pro" })` — `ASSEMBLYAI_API_KEY`
  - `deepgram({ model: "nova-3" })` — `DEEPGRAM_API_KEY`
  - `elevenlabs({ model: "scribe_v2_realtime" })` — `ELEVENLABS_API_KEY`
  - `soniox({ model: "stt-rt-v3" })` — `SONIOX_API_KEY`

  **Never inherit the `assemblyai` SDK's connect deadline.** Its default
  `connectTimeout` is **1000 ms** and covers far more than a socket open: the
  timer is armed before the WebSocket is constructed and only cleared when the
  server's `Begin` message arrives, so DNS + TCP + TLS + upgrade + the
  service's session-start latency all have to fit. A link measuring ~50 ms to
  TLS still blew it — a slow `Begin`, or a host event loop briefly blocked
  (this is a wall-clock `setTimeout`, not an I/O deadline), is enough. All
  three attempts then failed identically and the session died on a fatal
  `stt_connect_failed`, which reads as a provider outage and is not one.
  `host/providers/stt/assemblyai.ts` therefore always sets
  `connectTimeout`/`maxConnectionRetries`/`connectionRetryDelay` from
  `STT_CONNECT_*` in `sdk/constants.ts`, overridable per agent via
  `assemblyAIStt({ connectTimeoutMs, maxConnectRetries })`. The retry policy is
  pinned rather than left to the SDK so the worst-case open time is arithmetic
  we own: it runs inside `session.start()`, so a budget exceeding
  `DEFAULT_SESSION_START_TIMEOUT_MS` could only surface as the less specific
  "session.start() timed out". `assemblyai.test.ts` asserts that sum.
- **LLM**: one of the typed factories below — each returns a pure
  descriptor; the `@ai-sdk/*` package is only imported by the host-side
  resolver (`host/providers/resolve.ts`), never by the agent bundle:
  - `anthropic({ model })` — `ANTHROPIC_API_KEY`
  - `openai({ model })` — `OPENAI_API_KEY`
  - `google({ model })` — `GOOGLE_GENERATIVE_AI_API_KEY`
  - `mistral({ model })` — `MISTRAL_API_KEY`
  - `xai({ model })` — `XAI_API_KEY`
  - `groq({ model })` — `GROQ_API_KEY`
  - `openrouter({ model })` — `OPENROUTER_API_KEY`; routes through
    [OpenRouter](https://openrouter.ai)'s OpenAI-compatible
    chat-completions endpoint, one key fronting hundreds of models
    addressed as `"creator/model"` (e.g.
    `openrouter({ model: "meta-llama/llama-3.3-70b-instruct" })`).
    Resolved via `@ai-sdk/openai`'s `.chat()` client pointed at the
    OpenRouter base URL — no extra `@ai-sdk/*` dependency.
  - `gateway({ model })` — `AI_GATEWAY_API_KEY`; routes through the
    [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), one endpoint
    fronting hundreds of models addressed as `"creator/model"` (e.g.
    `gateway({ model: "zai/glm-4.6" })`). Resolved via `createGateway`
    from the `ai` package — no extra `@ai-sdk/*` dependency.
  - `assemblyAILlm({ model, region? })` — `ASSEMBLYAI_API_KEY`; routes through
    the [AssemblyAI LLM Gateway](https://www.assemblyai.com/docs/llm-gateway)
    (OpenAI-compatible chat-completions endpoint fronting 25+ models) via
    `@ai-sdk/openai`'s `.chat()` client. `region: "eu"` selects the EU
    The client is built with a `fetch` wrapper,
    `repairOpenAiStream` (`host/providers/_openai-stream-repair.ts`): the
    gateway documents streamed responses for OpenAI models only, and its
    Claude streams break two AI SDK expectations. (1) `tool_calls` deltas
    arrive with no `id`/`type`, which makes `StreamingToolCallTracker` in
    `@ai-sdk/provider-utils` throw `Expected 'id' to be a string` and kill any
    turn that calls a tool — the wrapper fills in a synthetic id (stable per
    tool-call index within one response) and `type: "function"`, leaving real
    ids alone. (2) The final usage-only chunk carries `"choices": null` where
    the schema requires an array, so the turn dies with "Type validation
    failed" *after* the reply has streamed — the wrapper rewrites that null to
    `[]` (an absent `choices` stays absent). Every other byte passes through.
    Remove each repair once the gateway emits conformant frames.
- **TTS**: one of
  - `cartesia({ voice })` — `CARTESIA_API_KEY`
  - `rime({ voice })` — `RIME_API_KEY`
  - `assemblyAITts({ voice, language? })` — `ASSEMBLYAI_API_KEY`; AssemblyAI's
    streaming TTS over `wss://streaming-tts.assemblyai.com/v1/ws/`.
    Sharing one key with STT and the gateway means an all-AssemblyAI pipeline
    needs exactly one secret. Two protocol details that are easy to get wrong:
    the streaming sockets authenticate with the **raw** key, not `Bearer`, and
    production sends no `Begin` frame until the client speaks first, so the
    adapter must not block waiting for one (the AssemblyAI CLI does, which is
    why it marks prod streaming TTS unavailable). Turns end on `FlushDone`;
    a rejected key arrives in-band as an `Error` frame, i.e. as
    `tts_stream_error` rather than `tts_auth_failed`.

    A third, and the one that decides whether the agent feels responsive:
    **`Generate` only buffers — `Flush` is what starts synthesis.** Unlike
    Cartesia (`continue: true` synthesizes on arrival), relaying LLM deltas and
    flushing once makes time-to-first-audio the length of the whole turn, since
    the pipeline's only provider-level flush is the end-of-turn drain
    (`flushTtsAndWait`, once per reply — after every LLM step *and* tool call).
    A tool-chaining reply was silent for its entire duration, `holdPhrase` and
    the dead-air cover included, as those are just more buffered text. The
    adapter therefore buffers host-side and emits `Generate`+`Flush` per
    *sentence*: measured, that is ~350ms to first audio instead of the full
    turn, for ~4% more total audio, where flushing every word-granularity delta
    costs 2.6x and sounds disjointed. Two invariants come with it — only the
    turn's **last** acknowledgement may emit `done` (`flushTtsAndWait` resolves
    on it, so a segment's `FlushDone` leaking through advances the orchestrator
    mid-reply), and the end-of-turn flush is never sent empty, so `done` never
    depends on the service acking a contentless `Flush`. See the module doc in
    `host/providers/tts/assemblyai.ts` for the measurements.

The provider SDKs (`ai`, `assemblyai`, `@cartesia/cartesia-js`,
`@ai-sdk/*`, …) are regular dependencies of `@alexkroman1/aai`, but they
are only imported by the host-side openers/resolvers in
`host/providers/` — the descriptor factories in `sdk/providers/` are pure
data, so agent bundles never pull provider SDKs into the guest sandbox.

Each provider defines its `KIND` tag and `<PROVIDER>_API_KEY_ENV`
constant once in its `sdk/providers/{stt,tts,llm}/<name>.ts` module.
Adding a provider means: descriptor factory there, an opener in
`host/providers/{stt,tts}/` (built on the shared session shell in
`host/providers/_utils.ts`), and one registry/switch entry in
`host/providers/resolve.ts`.

## Voices

**`ASSEMBLYAI_TTS_VOICES` in `sdk/providers/tts/assemblyai.ts` is the list.**
Read it there; do not restate it here, and do not trust a voice name that
isn't in it.

That instruction is the whole point of the constant. This section used to
carry its own table — `ivy`, `sam`, `mia`, `jack`, `sophie`, `oliver` and a
dozen more — of which every entry was either deprecated or had never
existed, and it claimed a `voice:` field on `agent()` that the SDK does not
have. The provider's doc comment carried a *different* wrong list
(`azelma`, `cosette`, `fantine`, `javert`, …, none published). Two
hand-maintained lists, both fiction, both pointed at by anyone looking for a
voice.

The failure they cause is invisible at authoring time: a wrong voice id is
rejected in-band after the TTS socket opens, so the agent connects, reports
ready, and is permanently silent. Nothing before a live session catches it.
Hence one checkable constant, with the accent alongside each name and the
deprecated set kept separately in `ASSEMBLYAI_TTS_DEPRECATED_VOICES`.

On the default pipeline the voice is the top-level `voice` field —
`agent({ voice: "michael" })`, an author convenience desugared to
`tts: assemblyAITts({ voice })` in `normalizeAgentConveniences` (typed
against the catalog, invalid alongside an explicit `tts` descriptor, which
owns its own voice). An explicit AssemblyAI TTS stage picks it with
`assemblyAITts({ voice })` from `@alexkroman1/aai/tts` (or
`assemblyAIPipeline({ voice })`). S2S mode's voice rides on the `s2s`
descriptor — `voice` is a compile error there.

## Storage (`ctx.db`)

There is no KV store anymore. Persistent state is the opt-in **app
database**: enabling storage for an app (CLI `aai storage enable` — the
studio deliberately has NO storage toggle, so this is a CLI-only action;
or `DATABASE_URL` in the project `.env` under
`aai dev`) gives its tools `ctx.db` — a SQL handle
(`query<T>(sql, params?)`, `$1` placeholders) backed by a per-app schema in
the platform's Supabase Postgres. Accessing `ctx.db` without storage
enabled throws with that enablement guidance. On the platform each app
gets its own schema + login role (search_path pinned, 10s
statement_timeout); credentials live in Supabase Vault. Session-scoped
scratch belongs in `ctx.state` (or the `remember`/`recall` builtins, now
in-memory per-session).

There is no Vector store anymore — `ctx.vector`, the `vector:` agent field,
the `@alexkroman1/aai/vector` subpath, and the platform-owned
`PINECONE_API_KEY` were all removed. If retrieval comes back it will be a
Supabase (pgvector) store following the same path as `ctx.db`: per-app
schema, platform-provisioned credentials in Vault.
`ctx.db` connects DIRECTLY from the guest: the app's own scoped Postgres
credentials (role/search_path pinned at provisioning) ride into the guest as
`DATABASE_URL` in the agent's boot env, and the bundle's runtime opens its
own connection — exactly as `aai dev` does with a project `.env`. The old
host-proxied `db/query` RPC is gone: it kept a versioned RPC in the
harness↔bundle contract to protect a credential that only reaches the
tenant's own data anyway.

## Guest network access

There is **no per-agent egress policy**. `allowedHosts` and its enforcement
stack (the SDK's `tool-egress`/`guest-fetch-policy` in-process guard, the
platform's Modal outbound-domain allowlist, `guest-egress.ts`) were removed:
the agent's own code runs in the guest with open egress, exactly as it does
under `aai dev`. The Modal container is the isolation boundary — a tenant
can reach the internet, not the platform. Tool code and providers `fetch`
directly.

**The network builtins follow one rule: screen only when there is no
container around us** (`builtinFetch` in `host/ssrf.ts`).

- **Contained** (a Modal Sandbox) → plain `pinnedFetch`, no SSRF screen. The
  screen guards nothing a tenant cannot bypass in one line, because their own
  tool code has open egress by design — so it constrains the *model*, not the
  author. The container is the boundary and it holds no PLATFORM credentials
  (`ctx.db`'s DATABASE_URL is the app's own scoped role).
- **Not contained** (`aai dev`, and the subprocess backend) → `safeFetch`.
  Here the host IS someone's machine: these same builtins run in the
  developer's own process, where a model-controlled URL can reach localhost,
  the LAN, or cloud metadata. That is the case the screen exists for.

Containment is **declared by the spawner**, never inferred by the guest:
`modal-sandbox.ts` sets `AAI_SANDBOX_CONTAINED=1` in the exec env and the
subprocess backend does not. "Am I a guest" and "am I contained" are
different questions — the subprocess backend runs a guest with no container
at all, so a guest-token sniff would open egress on a developer's laptop.
`ssrf.test.ts` pins that distinction.

The residual risk in a container is prompt injection steering the model at an
internal endpoint; accepted, because the sandbox has nothing internal worth
reaching and an author who wants that can already write it.

## Default values and magic numbers

All numeric constants live in `packages/aai/sdk/constants.ts` (client-audio
budgets are split into `sdk/client-audio-constants.ts` for file-length reasons
and re-exported from `constants.ts`, so the import path is unchanged). Key
defaults that affect agent behavior:

| Default | Value | Where applied | Notes |
| --- | --- | --- | --- |
| `maxSteps` | 10 (`DEFAULT_MAX_STEPS`) | `constants.ts` | Max tool calls per reply. Prevents runaway tool loops; sized so multi-tool chains plus a repair retry fit. |
| `toolChoice` | `"auto"` | runtime resolution | LLM decides when to use tools vs respond directly. Full AI SDK set: `"auto"`, `"required"`, `"none"`, `{ type: "tool", toolName }`. |
| `idleTimeoutMs` | 300,000 (5 min) | `constants.ts:26` | `0` or non-finite disables the timer entirely. Re-armed on every inbound audio frame (`resetIdle`), so it measures silence, not call length. On expiry session-core emits `idle_timeout` **and closes the socket** — the event alone retires nothing (clients treat it as informational and wait for the close), so for a long time an idle session lingered and only Modal's 300s input cap reaped it. |
| `silenceTimeoutMs` | unset (disabled) | `pipeline-silence.ts` | Pipeline only: assistant proactively takes a turn after this much user silence. Capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back nudges until the user speaks again. `silencePrompt` customizes the injected instruction (default `DEFAULT_SILENCE_PROMPT`); it is kept in LLM history but never emitted as a user transcript. |
| `minBargeInWords` | 2 (`DEFAULT_MIN_BARGE_IN_WORDS`) | `constants.ts` | Pipeline only: interim-transcript words before user speech interrupts the in-flight reply. 2 keeps one-word backchannels from cutting the agent off; sub-threshold finals are answered after the reply. |
| `interruptionMinDurationMs` | 500 (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`) | `constants.ts` | Pipeline only: sustained speech (ms since the utterance's first partial) required before an interim-triggered barge-in fires — LiveKit's `min_interruption_duration` analog. Non-zero by default: room noise and echo of the agent's own voice produce short interim transcripts, and each one used to abandon a reply mid-word. Finals are never gated. 0 disables. |
| AssemblyAI `min_turn_silence` | 2000 (`DEFAULT_MIN_TURN_SILENCE_MS`) | `host/providers/stt/assemblyai.ts` | End-of-turn silence before the service commits a `final`. Endpointing lives in the STT provider — the pipeline transport commits a turn on every final — so this is what keeps a mid-utterance pause from splitting one request across turns. Raised from 1500 after Full-Duplex-Bench v3 caught 1500 splitting real hesitant speech mid-sentence; the benchmark's own breakdown localizes it to *silence* rather than word accuracy (self-corrections and false starts passed 100%, hesitations 33%, pauses 57%). Override via `assemblyAIStt({ minTurnSilenceMs })`. |
| Deepgram `endpointing` | 1500 (`DEFAULT_DEEPGRAM_ENDPOINTING_MS`) | `sdk/providers/stt/deepgram.ts` | Same role as `min_turn_silence` above — the provider owns end-of-turn; override via `deepgram({ endpointing })`. |
| `holdPhrase` | `"One moment."` (`DEFAULT_HOLD_PHRASE`) | `pipeline-stream.ts` | Pipeline only: spoken when a turn opens with a tool call and no speech. `""` disables. |
| `errorPhrase` | `"Sorry, I had a problem just then. Could you say that again?"` (`DEFAULT_ERROR_PHRASE`) | `pipeline-turn-outcome.ts` | Pipeline only: spoken when the turn's LLM stream fails, so a provider outage hands the conversation back instead of going silent. A failed turn produces no text, so nothing would otherwise reach TTS and the only trace is a `llm` session error the browser surfaces without a sound. `""` disables. |
| dead-air cover | 2000 ms (`DEFAULT_DEAD_AIR_COVER_MS`) | `pipeline-stream.ts` | Pipeline only: tool execution that sends nothing to TTS for this long gets a `DEAD_AIR_COVER_PHRASES` filler — unlike `holdPhrase` this is time-based, so it still fires after the model has spoken, and repeats across a tool chain with the wait doubling each time. `holdPhrase: ""` disables both. |
| `falseInterruptionTimeoutMs` | 2000 (`DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS`) | `constants.ts` | Pipeline only: a partial-triggered barge-in that never commits a user turn (STT noise) resumes the interrupted reply via a synthetic continuation turn after this window. A mid-turn cut resumes from the `[interrupted]` history marker (`DEFAULT_FALSE_INTERRUPTION_PROMPT`); a cut during the client playback tail — the reply finished server-side but was still playing out — resumes with a prompt quoting the estimated last-heard words (`buildTailResumePrompt`), unless less than `TAIL_RESUME_MIN_UNHEARD_MS` of audio was unheard. 0 disables. |
| `maxHistory` | 200 | `constants.ts:52` | Sliding window of conversation messages retained. |
| resume grace | 120,000 (`SESSION_RESUME_GRACE_MS`) | `constants.ts` | How long a disconnected session's per-session tool state (`ctx.state`) survives awaiting a `?sessionId=<id>` resume — the runtime's stateMap sweep (in-guest on the platform, in-process under `aai dev`) waits it out, cancelled when the session resumes. Sized above the browser client's worst-case automatic-reconnect span (~105s); the client reconnects with the sessionId from the `config` frame, so the resumed session finds its state under the same key. |
| `builtinTools` | `DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) | `constants.ts` | Cognitive built-ins on by default: private reasoning scratchpad, session notes, safe calculator. Set `builtinTools` explicitly (including `[]`) to override. `web_search`/`visit_webpage`/`get_page_design`/`fetch_json`/`run_code` remain opt-in. A custom or relayed tool with the same name wins — the built-in is dropped. |

## Self-hosted server defaults (`aai/host/server.ts`)

`createServer` has no request authentication of its own — it is the `aai dev`
backend, not the managed platform. Two defaults exist because of that, and
both are fail-closed:

- **Binds loopback.** `listen(port, host = DEFAULT_LISTEN_HOST)` defaults to
  `127.0.0.1`. Pass `"0.0.0.0"` deliberately to expose it; binding every
  interface by default put a developer's agent (and the provider credentials
  behind it) in reach of anyone on the same network. `aai dev` exposes this as
  `AAI_DEV_HOST` for setups where loopback isn't reachable (e.g. running in a
  container and connecting from the host).
- **Host mode is opt-in.** A `?host=1` WebSocket lets the *client* supply the
  agent definition (`systemPrompt`, `greeting`, relayed tool schemas) while the
  session runs on the operator's credentials, so `isHostAllowed` requires an
  explicit `AAI_ALLOW_HOST` of `1`/`true`/`yes`/`on`. Unset means off.
  Harnesses (e.g. tau2) set it themselves. Note `resolveServerEnv` only
  surfaces keys declared in `.env`, so `aai dev` passes the shell value through
  explicitly (`hostModeEnv`) — otherwise exporting the variable the usual way
  would have no effect.
