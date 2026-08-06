# packages/aai — SDK guide

The shared core SDK (`@alexkroman1/aai`). Repo-wide commands, conventions,
testing rules, and the changeset/PR workflow live in the root `CLAUDE.md`;
platform behaviour lives in `packages/aai-server/CLAUDE.md`.

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

## Package exports

Subpath exports consumed by sibling packages and user agents:

- `.` — `agent()`, `tool()` helpers, `Db`, types, utils, constants
- `./utils` — zod-free utilities + platform slug contract (fast CLI startup path)
- `./runtime` — full Node.js runtime engine (barrel → 11 host/ modules)
- `./protocol` — wire-format Zod schemas, `lenientParse()`, `ClientEvent`
- `./manifest` — `toAgentConfig()`, `agentToolsToSchemas()`, config schemas
- `./stt` — pipeline-mode STT provider factories (e.g. `assemblyAIStt`)
- `./llm` — pipeline-mode LLM provider factories (e.g. `anthropic`)
- `./tts` — pipeline-mode TTS provider factories (e.g. `cartesia`)
- `./s2s` — S2S provider factories (`openaiRealtime`)
- `./tools` — keyless network builtins callable from user tool code
- `./internal` — infrastructure shared with sibling packages (epochs,
  owned maps, WS upgrade parsing, schema-issue formatting); not a public
  API, kept off the root barrel so authoring autocomplete stays small.
  The env brands live on `./runtime` instead — they appear in its public
  signatures (`RuntimeOptions`, `withHostCredentialFallback`)

## Subpath export → file mapping

Tracing imports through barrel files can be confusing. Here's the map
of subpath exports in `aai/package.json`:

| Import path | Resolves to | What it contains |
| --- | --- | --- |
| `@alexkroman1/aai` | `packages/aai/index.ts` → 6 modules | Types, Db, utils, constants, `agent()`/`tool()` helpers |
| `@alexkroman1/aai/utils` | `sdk/utils.ts` (direct, not a barrel) | Zod-free utilities (`errorMessage`, `errorDetail`, …) + the slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS` from `sdk/slug.ts`). Deliberately dependency-free so the CLI can load it on every invocation without paying zod's startup cost |
| `@alexkroman1/aai/runtime` | `host/runtime-barrel.ts` → 11 modules | Full Node.js runtime: session, S2S, server, tools, WS handler |
| `@alexkroman1/aai/protocol` | `sdk/protocol.ts` (direct, not a barrel) | Wire-format Zod schemas, `lenientParse()`, `ClientEvent`, `ServerMessage` |
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` → 3 modules | `toAgentConfig()`, `agentToolsToSchemas()`, `AgentConfig`/`ToolSchema` + their Zod schemas, config-rule asserts. (The subpath name is historical — the old `parseManifest()`/`Manifest` layer was deleted; renaming the published subpath wasn't worth the break.) |
| `@alexkroman1/aai/stt` | `sdk/providers/stt-barrel.ts` | STT provider factories + types (`assemblyAIStt`, `deepgram`, `elevenlabs`, `soniox`) |
| `@alexkroman1/aai/llm` | `sdk/providers/llm-barrel.ts` | LLM provider factories + types (`anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `openrouter`, `gateway`) |
| `@alexkroman1/aai/tts` | `sdk/providers/tts-barrel.ts` | TTS provider factories + types (`cartesia`, `rime`, `assemblyAITts`) |
| `@alexkroman1/aai/s2s` | `sdk/providers/s2s-barrel.ts` | S2S provider factories + types (`openaiRealtime`; `assemblyAIS2s` is on the root export) |
| `@alexkroman1/aai/tools` | `host/agent-tools.ts` (direct, not a barrel) | Keyless network builtins callable from user tool code: `fetchJson`, `visitWebpage`, `webSearch` |
| `@alexkroman1/aai/internal` | `internal.ts` → 5 modules | Cross-package infrastructure (`createEpoch`, `createOwnedMap`, `createCoalescingRunner`, `parseWsUpgradeParams`, `formatSchemaIssues`). Not public API, not semver-covered, excluded from the docs |

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

  **A failing TURN is not a failing SESSION** (`EmitError` in
  `transports/types.ts`, `createEmitError` in `transports/pipeline-error.ts`).
  `onError` defaults to `fatal: true`, and aai-ui answers a fatal frame by
  calling `cleanupAudio()`, bumping the connection generation and setting
  `running: false` — the microphone is RELEASED and the call ends. Only the two
  paths that really terminate may report that way, and both call `terminate()`:
  `onProviderError` and the provider-open rejection (a session with no STT
  cannot hear). The three turn-level reporters pass `{ fatal: false }` — an
  `error` part in the LLM stream, a thrown `streamText`, and a TTS flush
  timeout. Reported as fatal, the first two were especially perverse: the
  transport's next act is to speak `errorPhrase` ("Sorry, I had a problem just
  then. Could you say that again?") and invite another turn, so the caller was
  asked to repeat themselves into a microphone the client had just switched off,
  while the TTS case ended a live call over one clipped sentence. The pipeline
  fuzz covers both LLM reporters (separate code paths: an `error` stream part,
  and a request that never streams); the TTS one needs a real deadline to
  elapse, so a deterministic spec pins it.
- **S2S mode** (explicit opt-in — `s2s: assemblyAIS2s()` from the main
  export, or `openaiRealtime()` from `@alexkroman1/aai/s2s`) uses
  `createS2sTransport()` in `packages/aai/host/transports/s2s-transport.ts`.
  The host opens a single WebSocket to AssemblyAI's speech-to-speech
  service; STT, the LLM loop, and TTS all run service-side and audio/events
  relay through that one socket. This is the original architecture, and was
  the implicit default before the pipeline-by-default flip. There is no way
  to reach S2S by omission — only the `s2s` descriptor selects it.

  **The Voice Agent API accepts ONE sample rate — 24 kHz, both directions — so
  the CLIENT must send true 24 kHz audio, not 16 kHz relabelled as 24.** The
  host pins and advertises the rate and refuses a client that declares another;
  it does NOT resample (see the end of this section for why). Measured
  against the live service (2026-08-05) with a standalone WebSocket client,
  feeding the same real utterance three ways:

  | sent | declared | result |
  | --- | --- | --- |
  | 16 kHz bytes | 24 kHz | `session.ready`, then **nothing at all** |
  | resampled to true 24 kHz | 24 kHz | speech edges, correct transcript, 279 KB of reply audio |
  | 16 kHz bytes | 16 kHz | `session.error{internal_error}` + close **1011** |

  Row one is the whole problem: no `input.speech.started`, no
  `transcript.user`, and **no error** — the service applies 24 kHz regardless,
  decodes the audio 1.5x fast, and emits nothing. Output is unaffected, so the
  agent greets normally and is then permanently deaf, which reads as a model or
  service outage rather than an audio bug. Row three shows a wrong
  *declaration* at least fails loudly, which is why `updateSession` always puts
  the format on the wire.

  **Pinning the rate is necessary and NOT sufficient — that is the trap.**
  `pinAssemblyS2sRates` forces `S2SConfig` to 24 kHz before `buildReadyConfig`
  advertises it, on the reasoning that the ready frame tells the client what to
  capture. That holds for aai-ui, which asks its `AudioContext` for the
  advertised rate and asserts it was granted (`assertGranted`, `audio.ts`). It
  holds for nothing else: a programmatic client that treats the config frame as
  a bare handshake ack keeps sending what it always sent. tau2's harness is
  exactly that — its send rate is a module constant and its chunk size is
  derived from it at construction — so the pin changed every number in the
  stack and not one byte of audio. That run scored **2/25**, answering 62 of
  171 user turns and hitting an unresponsive period in **25 of 25** sessions,
  against 15/25 and 18/25 for the two pipeline transports running the same
  tasks at the same minute.

  Nothing later in the session can detect this: no number anywhere is wrong,
  every byte is, and the service reports neither. So the mismatch is refused at
  the door — `assertHostRatesSupported` (`host-mode.ts`) **rejects a host-mode
  handshake that declares a rate this transport cannot honour**, the host-side
  counterpart of aai-ui's `assertGranted`. Declaring nothing is fine and means
  "tell me what to use"; declaring 16 kHz is a protocol error naming the rate to
  use instead. `pinAssemblyS2sRates` keeps its warn for the one caller with no
  handshake to fail — an operator passing `s2sConfig` to `createRuntime`.

  **The host does not resample, deliberately.** A resampler was built and
  reverted: it worked (16 kHz converted to true 24 kHz transcribed correctly
  5/5 live, against 4/5 returning nothing when relabelled), but upsampling can
  only preserve or degrade — it invents no bandwidth — and it put ~150 lines of
  stateful DSP in the hot audio path to paper over a client that could simply
  send the right rate. Every client already owns its own rate conversion: the
  browser's WebAudio does it, tau2 resamples from 8 kHz μ-law regardless, so
  making it 8→24 costs nothing. Rate conversion belongs at the edge; the host's
  job is to state the requirement and refuse a client that will not meet it.

  **S2S has no agent captions on tool-call turns, and this is not our bug.**
  Measured against the live service (2026-08-03) with a standalone WebSocket
  client, no SDK in the path: `transcript.agent` is emitted for every non-tool
  reply with a matching `reply_id`, and for NEITHER reply of a tool-call turn —
  not the one carrying `tool.call`, not the one after `tool.result`. Declaring
  tools changes nothing; calling one does. So a tool-using agent renders blank
  reply text for exactly the turns that do the work, `reply.done` logs
  `agentText: "none"`, and `replyAnomaly` warns "delivered audio with no
  transcript" once per tool turn. Anything reading reply text (history, evals, a
  tau2-style harness scoring what the agent *said*) sees silence for a turn the
  user heard answered.

  The docs contradict each other on whether that is intended: the canonical
  message-sequence page shows `transcript.agent` inside its `opt tool call`
  branch and calls it "Per agent reply", while the execution-modes page's
  `interactive` diagram shows neither tool-turn reply emitting it — the service
  matches the latter.

  **`transcript.agent.delta` DOES arrive, and it is the remedy.** This guide said
  the opposite — "not implemented: zero frames arrive even for a plain greeting
  reply", with an instruction not to re-add the accumulator removed in #a42cdbd3.
  Re-measured 2026-08-06 against the live service with a standalone client
  (`tau2-bench/scripts/vaapi_delta_probe.py`, no SDK): a bare greeting reply —
  the exact case named as producing none — emits one frame per word carrying
  `start_ms`/`end_ms`. Over one 215s retail session, 511 frames across 20
  replies, of which **5 sent deltas and never a final `transcript.agent`** (116
  words, all tool-preamble turns, otherwise unrecoverable). Two properties decide
  how they are consumed, and neither matches the docs' "streaming ... useful for
  live captioning in sync with playback": they arrive in a **batch** (every delta
  for a reply within 0.000-0.031s), and they arrive **before** the final
  `transcript.agent` (0.4-7.7s earlier). So `s2s.ts` forwards the accumulation as
  a partial and, on a COMPLETED reply that never sent a final, commits it as the
  reply's transcript. Never on an interrupted reply: the batch covers the whole
  composed reply while `transcript.agent` with `interrupted: true` is trimmed to
  what was spoken, so committing it would put words in history the caller never
  heard.

  **S2S sends Voice Focus and `sttPrompt`; `languages`, `keyterms` and `voice`
  are still unreachable.** `updateSession` pins
  `input.voice_focus`/`voice_focus_threshold` from the same
  `DEFAULT_VOICE_FOCUS`/`DEFAULT_VOICE_FOCUS_THRESHOLD` constants the pipeline
  STT stage reads (the S2S default is the service's 0.7, and the interferer that
  matters is background speech), and forwards `sttPrompt` as
  `input.transcription_prompt`, trimmed to that field's documented 1750-char cap
  — keeping the HEAD, unlike `agent_context`'s tail-keeping trim, because this is
  a standing vocabulary description rather than a trailing question.

  `sttPrompt` was pipeline-only until 2026-08-06, which made it a SILENT config
  drop of exactly the class this guide warns about: `agent({ sttPrompt })` and
  `host.sttPrompt` both reached the agent definition and only
  `pipeline-transport.ts` read it, so an S2S agent that set one got unbiased
  transcription and no warning. `runtime-transport.test.ts` pins the forwarding
  at the point it was missing (verified to fail when reverted).

  What remains unreachable is `input.language_codes`, `input.keyterms` and
  `output.voice`, because `assemblyAIS2s()` takes no options at all — so an S2S
  agent cannot pick its voice either, and the claim elsewhere in this guide that
  "S2S mode's voice rides on the `s2s` descriptor" is wrong: `voice` is a compile
  error on `agent()` and there is no descriptor field to put it on. Note
  `languages` must stay AUTHOR-controlled rather than defaulted here — an unset
  value means "detect per turn", and a host-side `["en"]` would silently disable
  multilingual transcription for every agent, the mirror-image bug.

  Measured on tau2 retail (2 runs per arm, identical audio and pacing):
  `language_codes: ["en"]` + voice focus 0.9 + a `transcription_prompt` took the
  authenticating caller's first name from 1 of 6 attempts correct to 6 of 6, and
  word recall 0.892/0.913 → 0.931/0.924. `turn_detection` is deliberately NOT
  pinned: its default is adaptive and entity-aware (it waits out a spelled
  value), and setting `min_silence`/`max_silence` disables both for the session.

  **An in-band service error is NOT the end of the session, and a fatal frame
  is not a banner.** `SessionCore.onError` defaults to `fatal: true`, and
  aai-ui answers a fatal frame by calling `cleanupAudio()`, bumping the
  connection generation, and setting `running: false` — the MICROPHONE IS
  RELEASED. Both S2S transports used to report every in-band error that way:
  AssemblyAI's `session.error` with a non-expiry code (a rate limit, a rejected
  field) and its bare `error` frame, OpenAI Realtime's `error` event. None of
  those closes the socket, so the conversation demonstrably continued —
  `tool_call`, `reply_done`, and audio all arrived afterwards on most fuzz
  seeds — to a client that could no longer hear anyone, and a later event even
  recovered its state to "listening" (`clearRecoveredError`), leaving a session
  that looks live and is deaf. They now pass `{ fatal: false }`; the *only*
  reporter of session death is the close/failed-resume path (`endSession`),
  which is the one place that knows the link is gone and attaches the close
  code. A truly terminal error is still covered, because the service closes the
  socket after it. Note session-core logs a non-fatal error at DEBUG, so
  `s2s.ts` logs the `error` frame's message itself at warn — demoting the
  client-facing severity must not also make the service's complaint invisible.

  **Retiring the session must also DROP THE LINK** (`endSession`). Most fatal
  paths arrive from a close, where the socket is already gone — but not all:
  when the service rejects a `session.resume` with `session_not_found` it says
  so IN BAND and leaves the socket OPEN. The transport went on holding a live
  (billed) provider session and relaying its frames to a client it had just
  told the call was over. `endSession` closes the socket, drops the handle and
  the queued tool results, and the inbound callbacks are gated on the session
  still being live (`whileLive`) — `close()` does not un-deliver what is already
  buffered.

  **`stop()` must be able to abandon a handshake that has not completed**
  (`ConnectS2sOptions.signal`, aborted by the transport's `teardown` controller).
  `handle?.close()` can only reach a socket that OPENED: `connectS2s` returns a
  handle only on `open`, and `ws` sets no `handshakeTimeout`, so a client that
  hangs up mid-resume left a half-open (billed) provider connection pinned for
  the life of the process — nothing anywhere held a reference to close. A connect
  that loses this race is swallowed rather than reported: we aborted it, and
  there is no session left to fail. All three of these came out of the S2S
  property test (see "S2S property test" below), which shrank the last one
  to two commands: `session.ready`, then a transient drop.

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

  **`assemblyAIStt({ streamingUrl })` overrides the streaming endpoint** — for
  a staging cluster, or to A/B a pre-release host against the default. It is
  the same `websocketBaseUrl` mechanism `region: "eu"` already used, so an
  explicit URL WINS over `region`: naming an endpoint is deliberate and the
  residency shorthand must not silently overwrite it. The URL must carry the
  versioned path (`wss://host/v3/ws`); the SDK supplies that only for its own
  default host, so a bare origin connects to the wrong route and fails at
  connect. Leave unset in production — the SDK's default already tracks path
  bumps, which is why the US case pins nothing host-side.

  **An unset `languages` is "detect per turn", NOT "English".** Universal-3.5
  Pro code-switches across 18 languages natively, so a monolingual line pays
  for detection it does not want — and the failure does not look like a
  language problem. Measured against tau2-bench retail, English utterances came
  back transliterated into Devanagari and Hebrew script (`Hello? Any update?` →
  `हेलो एनी अपडेट`), authentication turns included, so the tool arguments built
  from them were garbage while every transcript looked like an ordinary
  mis-hearing. `assemblyAIStt({ languages: ["en"] })` pins one language (the
  `language_codes` connection parameter); a multi-element list biases toward a
  known subset while keeping code-switching. It stays UNSENT when absent — a
  host-side default would silently disable multilingual transcription for every
  agent, which is the mirror-image bug.
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

    **The default model is `gpt-5.6-luna`.** It has been `gpt-5.5` and
    `qwen3-next-80b-a3b` in between; the id is a one-line change, but it moves
    WHERE reasoning gets turned off, so read the two blocks below together
    before changing it again.

    **On the `gpt-5.6` family `reasoning_effort: "none"` is REQUIRED for tool
    use — not a tuning knob.** The default is now one of them, so this is the
    live path rather than a rule about a model an author might select. With
    `tools` present and any other effort — INCLUDING the model's own
    server-side default, i.e.
    sending no `reasoning_effort` at all — the gateway rejects the request:
    *"Function tools with reasoning_effort are not supported for gpt-5.6-luna
    in /v1/chat/completions. To use function tools, use /v1/responses or set
    reasoning_effort to 'none'."* Measured 2026-08-06 against the live gateway,
    4/4 attempts on both `-luna` and `-terra`. **`gpt-5.5` and
    `qwen3-next-80b-a3b` are both unaffected**, measured the same day: `"none"`,
    `"low"`, and no `reasoning_effort` at all each return a normal tool-calling
    completion, streaming included.

    **That message is not what this SDK would see.** The pipeline streams, and
    streaming turns the same rejection into a bare
    `{"message":"something went wrong","code":500}` with the explanation
    stripped — the diagnosis exists only in the non-streaming reply, which
    nothing in the pipeline sends. And since `DEFAULT_BUILTIN_TOOLS` puts four
    tools on every agent that does not opt out, an unguarded descriptor fails
    on *every* turn while reading as a gateway outage. So the constraint is
    encoded rather than documented: `TOOLS_REQUIRE_NO_REASONING` in
    `sdk/providers/llm/assemblyai.ts` makes the factory default
    `reasoningEffort` to `"none"` for those model ids, covering all three ways
    a descriptor is built — `assemblyAILlm()` bare, the `llm: "gpt-5.6-luna"`
    string shorthand (`from-string.ts`), and an explicit `model`. An explicit
    `reasoningEffort` is still honoured, same rule as `gatewayUrl` winning over
    `region`. Add a model id to that set when the gateway adds one that shares
    the constraint; the generated catalog (`gateway-models.ts`) cannot carry it
    — its flags come from `supported_parameters`, which does not list
    `reasoning_effort` for ANY model, including ones that plainly honour it
    (a bogus value 400s naming the supported ones).

    **`assemblyAIPipeline()`'s explicit `reasoningEffort: "none"` is a
    backstop on the current default, and must stay anyway.** Because
    `gpt-5.6-luna` IS in `TOOLS_REQUIRE_NO_REASONING`, the factory now fills
    the same value and the preset's argument
    (`sdk/providers/assemblyai-pipeline.ts`) agrees with it rather than
    carrying the whole weight. That agreement is a property of the id, not of
    the pipeline: under `gpt-5.5` or `qwen3-next-80b-a3b` — the other two
    defaults tried, both outside the set — the preset's argument is the only
    thing turning reasoning off, and deleting it as redundant costs every
    default pipeline **1786ms p50 time-to-first-token against 999ms with
    reasoning off**, with seconds of pre-first-token silence rather than a
    failure as the symptom. So the two settings are pinned TOGETHER in
    `define.test.ts` (effort and model id in one test): the preset's `"none"`
    is what makes the next id change safe, and the pin is what makes an id
    change that needs a second look fail loudly.

    Why luna: it is $1/$6 per M against `gpt-5.5`'s $5/$30, and on
    time-to-first-token (2026-08-06, 18 paired tool-calling turns,
    `reasoning_effort: "none"` on both) p50 **832ms vs 999ms** — ~17%, not the
    multiple an early n=1 probe suggested. `claude-opus-4-8` is 1217ms and
    `claude-sonnet-5` 1568ms at the same settings. The 5x-looking gaps in the
    first measurements were an ARTIFACT of comparing luna-with-`none` against
    `gpt-5.5` on its reasoning DEFAULT (1786ms) — most of what looked like a
    model difference was the reasoning setting, which this pipeline turns off
    regardless of model. So the honest case for luna is cost (5x) plus a
    modest latency edge, not a latency multiple.

    **No default here has been chosen on answer quality**, which is the axis
    that should decide one — a tau2 run is what would settle it. Qwen has no
    paired latency numbers at all. Treat the current default as
    quality-unverified.
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
    adapter therefore buffers host-side and emits `Generate`+`Flush` **per
    segment** — a sentence end, or **40 characters** when no sentence end is in
    sight (`splitSegment` in `host/providers/tts/assemblyai-segment.ts`).

    **Segment LENGTH is the knob, not flush count, and it has a cliff on both
    sides.** Sentence-only segmentation makes time-to-first-audio the length of
    the reply's FIRST SENTENCE, which a long opening clause easily stretches
    past half a second. Measured 2026-08-06 against production on such a reply
    (medians of 3 runs): sentence-only 538ms to first audio / 12.64s of audio,
    adding the 40-char budget **286ms / 14.00s** — half the latency for ~11%
    more audio. But going finer collapses: same text, 15 flushes (per-3-word)
    produced **21.20s** and per-delta 3.1x. The service's `WordBoundaries`
    frames name the mechanism — under per-delta flushing their `audio_start_ms`
    steps 0, 880, 1680, 2400, i.e. **every flush is padded into a ~800ms slot
    however little text it carries**. So "stream continuously" is not available
    on this protocol at any useful quality; the budget is a floor-BREAKER (a
    buffer already holding whole sentences still flushes as one large segment),
    and a per-clause boundary was measured and buys nothing, because clause
    marks cluster near sentence marks anyway.

    Two invariants come with segmenting — only the
    turn's **last** acknowledgement may emit `done` (`flushTtsAndWait` resolves
    on it, so a segment's `FlushDone` leaking through advances the orchestrator
    mid-reply), and the end-of-turn flush is never sent empty, so `done` never
    depends on the service acking a contentless `Flush`. A third is local to
    segmentation: `sendText` must drain **every** segment a delta carries, since
    a budget split consumes only its own — emitting one and waiting for the next
    delta reintroduces the whole-turn lag whenever no next delta comes. See the
    module doc in `host/providers/tts/assemblyai-segment.ts` for the full curve.

The provider SDKs (`ai`, `assemblyai`, `@cartesia/cartesia-js`,
`@ai-sdk/*`, …) are regular dependencies of `@alexkroman1/aai`, but they
are only imported by the host-side openers/resolvers in
`host/providers/` — the descriptor factories in `sdk/providers/` are pure
data, so agent bundles never pull provider SDKs into the guest sandbox.

Each provider defines its `KIND` tag and `<PROVIDER>_API_KEY_ENV`
constant once in its `sdk/providers/{stt,tts,llm,s2s}/<name>.ts` module.
Adding a provider means: descriptor factory there, an opener in
`host/providers/{stt,tts}/` (built on the shared session shell in
`host/providers/_utils.ts`), and one entry in the matching registry in
`host/providers/resolve.ts`.

**All four stages are registries, S2S included.** For a long time only
STT/TTS/LLM were: S2S was three hand-written kind comparisons, and they
had drifted apart on the failure mode. `buildTransport` THREW on an
unrecognized kind, while `requiredProviderEnvVars` FELL THROUGH to
`ASSEMBLYAI_API_KEY` and `ALL_PROVIDER_ENV_VARS` listed the two vendor
keys by hand. A third S2S vendor would therefore have made both credential
preflights — the platform's deploy boundary (`aai-server/deploy.ts`) and
`aai dev`'s — reject the deploy while naming a key the agent does not use
and never naming the one it does, which is exactly the silently-wrong-vendor
failure the STT/TTS registries were built to prevent. `S2S_REGISTRY` closes
it: `S2sKind` is the closed union of its keys, `isS2sKind` narrows to it,
and the dispatch in `runtime-transport.ts` is an exhaustiveness switch over
that union — so a registry entry with no transport builder is a compile
error rather than a first-session throw. S2S credentials also honour a
descriptor's `apiKeyEnv` now, like every other stage; they resolve through
`resolveS2sEnvVar`, so the key a session reads is by construction the key
the preflight asked for.

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

## Storage (`ctx.db`)

There is no KV store anymore. Persistent state is the opt-in **app
database**: enabling storage for an app (CLI `aai storage enable <slug>`; the
studio's Settings pane → Database, which switches BOTH of a project's agents
at once — see the Database-card note in
`packages/aai-studio-client/CLAUDE.md`; or
`DATABASE_URL` in the project `.env` under
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

## `speech_started` means "the agent is yielding", on BOTH transports

The two transports derive this event differently and a client cannot tell them
apart, so pipeline mode holds it back to match S2S rather than emitting what it
happens to know. In S2S the service fires its speech-started the moment it stops
generating, so the event coincides with a real interruption. Pipeline mode has
no VAD and derives the edge from the STT transcript stream, where the FIRST
non-empty partial opened it — one word of a cough, a backchannel, or a phrase
the caller addressed to someone else in the room. `minBargeInWords` and
`interruptionMinDurationMs` correctly declined to abort the reply for those, so
the agent kept talking; the client had been told it stopped.

**That divergence is not cosmetic, because clients act on it.** tau2-bench's
harness DISCARDS its entire agent playout buffer on `speech_started` and has no
`cancelled` handler at all — so the one event that really means "the agent
stopped" is ignored, and the one that did not is treated as authoritative. A
reply still being spoken was thrown away mid-sentence. `aai-ui` reads the same
event as informational (it only clears the caption; playback stops on
`cancelled`), which is why this never showed up in the browser.

Measured by replaying the benchmark's own recorded caller audio against a live
pipeline agent (`scripts/voice-replay/`), on the run's 10 conversations richest
in these signals: **184 `speech_started` against 87 `cancelled` — 53% of the
events the client acted on were not interruptions at all.** The agent yielded
to non-directed speech on 12 of 12 occasions and then sat silent a median 5.9s
(these are real barge-outs, not inter-sentence gaps: only 2.5% of natural gaps
between agent segments are ≤0.6s).

So while the agent holds the floor the edge is HELD, and released only when a
barge-in really fires (alongside `cancelled`) or when the agent stops speaking
on its own — `createGatedSpeechEdges` in `pipeline-user-speech.ts`. While the
agent is silent it passes straight through: there is no floor to yield and the
event just means "listening". Live captions are unaffected either way, because
`user_transcript_partial` is emitted independently of the gate.

The property to preserve — and what the specs in `pipeline-voice-events.test.ts`
pin — is that **the score no longer depends on how the client reads the event**.
Across the panel, the spread between a client that truncates on
`speech_started` and one that truncates on `cancelled` collapsed from up to
**66.7 points** (R_Y 89.7% vs 46.7%; S_BC 33.3% vs 100%) to **≤2.7 points**
(R_Y 44.1% both ways). Note which direction R_Y moved: the benchmark's
flattering 90% yield rate was an ARTIFACT of the same bug that wrecked
selectivity — truncating on a signal that arrives ~470ms after the first partial
makes yields look instant. A correct client's yield rate against the old code
was already 46.7%. Do not read the drop as a regression, and do not "fix" it by
reverting the gate.

## Data flow

On the platform, the browser's session WebSocket connects DIRECTLY to the
agent's sandbox (`/session` on its Modal tunnel, discovered via the
`GET /:slug/client-config` broker) — "server" below means the process
running the runtime: the guest harness on the platform, the `aai dev`
server locally. Audio path depends on the session mode (see above):

- **S2S mode**: user speaks → browser captures PCM → WebSocket → server
  relays audio into a single AssemblyAI S2S socket → agentic loop (LLM +
  tools) runs service-side → synthesized audio streams back through the
  same socket → server forwards to browser → user can interrupt at any
  time (cancels the in-flight turn).
- **Pipeline mode**: user speaks → browser captures PCM → WebSocket →
  server forwards audio to the STT provider → STT partials stream to the
  client as `user_transcript_partial` (live captions) and drive
  `speech_started`/`speech_stopped` edges → the committed transcript fires
  `onUserTranscript` → host runs the LLM loop locally via `streamText`
  (tool calls execute on the host just like S2S mode) → assistant text
  chunks stream into the TTS provider → synthesized audio returns over
  the client WebSocket → interrupts cancel the in-flight LLM stream and
  TTS playback. A barge-in that never commits a user turn is treated as a
  false interruption and the reply resumes (see
  `falseInterruptionTimeoutMs`).

## Default values and magic numbers

All numeric constants live in `packages/aai/sdk/constants.ts` (client-audio
budgets are split into `sdk/client-audio-constants.ts` for file-length reasons
and re-exported from `constants.ts`, so the import path is unchanged). Key
defaults that affect agent behavior:

| Default | Value | Where applied | Notes |
| --- | --- | --- | --- |
| `maxSteps` | 10 (`DEFAULT_MAX_STEPS`) | `constants.ts` | Max tool calls per reply. Prevents runaway tool loops; sized so multi-tool chains plus a repair retry fit. **Measured and left alone**: across 815 replies in two tau2-bench retail runs, 28-33% of replies called a tool at all, and among those the count was p50 **1**, p90 3, p99 5-6. Exactly **one reply of 815 reached the cap**, and it still scored reward 1.0. So the cap is binding on ~0.1% of replies and is not what limits chain length. Do not lower it on the strength of that thin tail: dropping to 5 would truncate ~0.4% of replies, and a truncated chain is strictly worse than a slow one — the agent stops holding a half-answer instead of finishing. Do not raise it either; nothing measurable is waiting on steps 11+, and the real constraint on a long chain is caller patience, not step count. That capped reply is the illustration: after its preamble it made **7 consecutive tool calls with no speech at all**, so what the caller experienced was dead air (see `DEFAULT_DEAD_AIR_COVER_MS`), not a step limit. Tune the silence, not the cap. |
| `toolChoice` | `"auto"` | runtime resolution | LLM decides when to use tools vs respond directly. Full AI SDK set: `"auto"`, `"required"`, `"none"`, `{ type: "tool", toolName }`. |
| `idleTimeoutMs` | 300,000 (5 min) | `constants.ts:26` | `0` or non-finite disables the timer entirely. Re-armed on every inbound audio frame (`resetIdle`), so it measures silence, not call length. On expiry session-core emits `idle_timeout` **and closes the socket** — the event alone retires nothing (clients treat it as informational and wait for the close), so for a long time an idle session lingered and only Modal's 300s input cap reaped it. |
| `silenceTimeoutMs` | unset (disabled) | `pipeline-silence.ts` | Pipeline only: assistant proactively takes a turn after this much user silence. Capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back nudges until the user speaks again. `silencePrompt` customizes the injected instruction (default `DEFAULT_SILENCE_PROMPT`); it is kept in LLM history but never emitted as a user transcript. |
| `minBargeInWords` | 2 (`DEFAULT_MIN_BARGE_IN_WORDS`) | `constants.ts` | Pipeline only: interim-transcript words before user speech interrupts the in-flight reply. 2 keeps one-word backchannels from cutting the agent off; sub-threshold finals are answered after the reply. |
| `interruptionMinDurationMs` | 500 (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`) | `constants.ts` | Pipeline only: sustained speech (ms since the utterance's first partial) required before an interim-triggered barge-in fires — LiveKit's `min_interruption_duration` analog. Non-zero by default: room noise and echo of the agent's own voice produce short interim transcripts, and each one used to abandon a reply mid-word. Finals are never gated. 0 disables. |
| AssemblyAI `min_turn_silence` / `max_turn_silence` | 1600 / **2500** (`DEFAULT_MIN_TURN_SILENCE_MS`, `DEFAULT_MAX_TURN_SILENCE_MS`) | `host/providers/stt/assemblyai.ts` | **Two knobs, not one, and the pause-tolerance one is the MAX.** On Universal-3.5 Pro the minimum is when the model runs its end-of-turn CHECK: the turn ends only if it READS as complete, otherwise a partial is emitted and the turn stays open. The maximum force-ends regardless of content. So the minimum is the latency floor on every finished utterance, while the maximum is paid only by utterances that never read complete. Both are always sent, because the service defaults them independently (min from the `mode` preset — 128/128/800 for `min_latency`/`balanced`/`max_accuracy` — and max to **1536**), and sending only one is how they invert. That inversion is the bug this pair replaced: the minimum was raised 1500 -> 2000 -> 3000 chasing Full-Duplex-Bench v3's hesitation recording while the maximum was never set, so from 2000 on the check could not fire before the content-blind force-end at 1536 had closed the turn — every ending came from the acoustic fallback, which is the mechanism that splits utterances, and the 3000 step changed nothing while taxing every complete utterance ~3s. The two knobs guard opposite splits, so the minimum must clear the pause BETWEEN sentences and BETWEEN dictated characters, while the maximum clears the pause WITHIN one continuous thought. **1600 is RE-CONFIRMED against AssemblyAI's new endpointer**, which ships on the `sandbox` runs and not the `default` ones — so the two archived retail runs A/B the models at an identical 1600, offline, by aligning every committed STT final to its gold utterance (`user_labels.txt`) over 549 substantive utterances: old 72% clean / **12.5% split** / 8.6% merged (balance +10, split-heavy), new 73% clean / **9.9% split** / 8.9% merged (balance +3, balanced). The new model splits 21% less at the same window and its error is now SYMMETRIC, which is the signature of sitting at the knee: it moved DOWN (the old model wanted a longer window at 1600, this one does not) but only modestly. **800 was then shipped anyway and REVERTED ON REWARD**, which is the strongest measurement this row carries: tau2-bench retail, same 25 tasks and seed, differing only in this pair — 1600/3500 scored **0.68** (mis-heard 43%, split/merged 23/14, 15 of 294 utterances corrupting a tool argument) against 800/1600's **0.12** (52%, 27/8, 26 of 264). A second run at 1600/3500 also scored 0.68, so 0.12 is a 5.7x regression, and the predicted signature held exactly: splits up ~30% per utterance, merges down ~37%, tool-argument corruption nearly doubled. On the wire the cancel ratio doubled too (`cancelled`/`reply_done` 0.41 -> 0.82, user turns with no reply 94 -> 139) — fragment finals make the agent answer half an utterance, and the rest of that breath then reads as a barge-in. So: splits are the expensive direction, truncating a spelled identifier so the tool call authenticates against a fragment, where a merge keeps every word and costs only latency. Do not raise it either; the symmetry is already there. **The MAX is now 2500, and it is the one number here with no measurement of its own** — 1600 and 800 moved together in that run, so it apportions no blame between them. 2500 buys back the ORDERING (it exceeds `DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS` 2000 again, so a barge-in on an incomplete utterance still finds it OPEN and `pipeline-recovery.ts`'s deferral is reached rather than skipped — at 1600 the force-end landed first and that branch was unreachable) at the cost of ~1s of hesitation tolerance against 3500. If splits reappear on hesitant, non-spelling utterances while spelled identifiers stay intact, put the max back to 3500; that asymmetry is what distinguishes the ceiling from the floor. **Two reusable instruments, both in tau2-bench:** `scripts/stt_errors.py` IS the gold-utterance alignment tool described here (greedy 1:1/1:2/2:1, reports cardinality, so a split is a named finding) and `scripts/failure_report.py` covers the wire side — do not rewrite either. And confirm the window was LIVE before trusting a null result: audio time is `tick x 0.2` and `user_labels.txt` shares that timeline, so gold-utterance-end to `user_transcript` measured median 2.00s at 1600/3500 against 1.20s at 800/1600 (p90 3.8s vs 2.2s). A dev-server restart is what loads a changed constant and `watchDirectory` ignores `node_modules`, where the linked SDK lives — which is why that run is a clean A/B despite three unrelated SDK commits landing inside its window, and why a run can silently measure the PREVIOUS value. Note `scripts/voice-replay/` CANNOT settle this knob (no tools, no database, so the truncated-auth regression is invisible to it) — use gold-utterance alignment over an archived run's `task.log`, or reward. Historical, against the old endpointer: **1600 was measured**: at 1000 tau2-bench retail regressed DB reward 1.00 -> 0.40 while NL assertions rose 0.60 -> 0.80 (the agent talked better and acted worse — it was authenticating against truncated spelled names, so no auth, no returns, unchanged DB). Pauses inside a single failing utterance measured 856-1455ms, nine of eighteen clearing 1000 and none clearing 1536. `pipeline-transport-options.test.ts` pins a 1000 floor, which is a floor and not a target. Override via `assemblyAIStt({ minTurnSilenceMs, maxTurnSilenceMs })`. **1600 has since been re-confirmed by a direct sweep** with Voice Focus at 0.9 (600/800/1200/1400/1600/1800/2000 ms x 4 replayed sessions): below 1600 the transcript over-segments (1.02-1.08x turns per gold utterance) and an auth field is lost — at 1200 the completeness check fires mid-surname, `Last name K-O-V-A-C-S` becomes two fragments, and `kovacs` never lands; at and above 1600 it is 0.99x and 12/12 auth fields survive. 1800 scores marginally better on every axis except p50 latency and is inside the noise for n=4 — 1600 is the knee, which is structural, and 1800 would be a sample maximum. **Do not tune this knob from a pause histogram.** The intra-utterance pause distribution in those same runs is p99 **593 ms**, with 1 gap in 1037 above 1200 ms, which argues 800 would do — and is the wrong instrument: percentiles describe what an ACOUSTIC endpointer needs, while on U3.5 Pro this is where the SEMANTIC completeness check runs, so the failures are "the check fired mid-spelling and the fragment read complete", which no pause distribution predicts. Latency behaves accordingly: 600 -> 2000 is a nominal 1400 ms but moves p50 endpoint latency only ~910 ms, and p90 is flat ~4.0-4.6s at every setting because the tail is content-driven. **`vad_threshold` is measured and deliberately LEFT ALONE** — see the Voice Focus row. **`interruption_delay` and `mode` are measured NO-OPS here**, which is worth knowing because the docs actively suggest reaching for the first: `interruption_delay=0`, `mode=min_latency` and `mode=max_accuracy` all leave first-partial latency at p50 0.47-0.52s, identical to unset, with no error frame and the parameter accepted. ~470 ms to first partial is a model floor, not a knob, so the only remaining lever on barge-in latency is our own `interruptionMinDurationMs`. |
| AssemblyAI `voice_focus` / `voice_focus_threshold` | `near-field` / 0.9 (`DEFAULT_VOICE_FOCUS_THRESHOLD`) | `host/providers/stt/assemblyai.ts` | **Both are always sent together; the threshold is above the service's own 0.7.** The interferer this tunes for is background SPEECH — a television, a radio, another conversation — and that is why no VAD setting substitutes: Voice Focus suppresses background audio BEFORE the model sees it while `vad_threshold` gates frames after, and those frames legitimately *are* speech, so a frame gate cannot tell "a voice" from "the caller's voice". The symptom reads as a hallucinating model and is not one: fluent, well-formed English the caller never said, in the register of whatever was playing behind them, prepended to their real utterance. **0.9 is measured** — tau2-bench retail, four sessions replayed byte-identical through the live service at 8 kHz telephony with a TV news bed at 15 dB SNR (`medium_size_room_tv_news_iphone_mic.wav`): against the service default, background words fell 32% -> 18% of all words heard, caller-speech recall rose 51% -> 70%, and the name/ZIP gating authentication survived 12/12 utterances against 9/12. At the default one authentication turn came back as "And we're getting that live look from the estuary here in Chaplin" and the tool call built from it was garbage. **`vad_threshold` was swept in the same harness and loses in BOTH directions**, which is why it stays unset: 0.6 cut leakage to 15% but collapsed recall to 51% and took key facts *below* baseline (8/12), because the caller's quiet spelled letters are exactly what a stricter gate discards; 0.05-0.20 left recall flat at 70-71% (voice focus had already saturated it) while leakage rose 19% -> 27%, buying one recovered utterance — the content-free "Still waiting." — for five words of traffic report. `far-field` is much worse here (44% leakage; it amplifies the room, which is where the interfering speech is), and disabling Voice Focus is catastrophic rather than a fallback: recall collapsed to 4% with ONE end-of-turn in 232 s, because continuous background speech never leaves enough silence to endpoint — so a suppression regression surfaces as a turn-taking failure, not a transcription one. Override via `assemblyAIStt({ voiceFocus, voiceFocusThreshold })`; the threshold is omitted entirely when voice focus is off. |
| Deepgram `endpointing` | 1500 (`DEFAULT_DEEPGRAM_ENDPOINTING_MS`) | `sdk/providers/stt/deepgram.ts` | Same role as `min_turn_silence` above — the provider owns end-of-turn; override via `deepgram({ endpointing })`. |
| `holdPhrase` | **`""` — off** (`DEFAULT_HOLD_PHRASE`) | `pipeline-stream.ts` | Pipeline only: filler spoken when a turn opens with a tool call and no speech; set a phrase to enable. Was `"One moment."` on the reasoning that dead air is worse than filler, and two measurements retired that. The silence it covers is now ~1s (LLM time-to-first-text p50 **1.10s** on a tau2 retail run) — a pause, not dead air — and `DEFAULT_DEAD_AIR_COVER_MS` still covers the long tool chains it was really for. Against that it costs the FIRST SENTENCE, which the voice rules spend deliberately: the opener is capped at eight words and must carry the answer, because interruption rate climbs with reply length (17% under 10 words to 59% past 35). It also would not stay scoped — prompt wording that merely PRESUPPOSED an opener drove filler-opening replies 15% -> 43%, and scoping the rule to tool turns only reached 29%, about the share of turns that call a tool. Removing the default removes the floor. |
| `errorPhrase` | `"Sorry, I had a problem just then. Could you say that again?"` (`DEFAULT_ERROR_PHRASE`) | `pipeline-turn-outcome.ts` | Pipeline only: spoken when the turn's LLM stream fails, so a provider outage hands the conversation back instead of going silent. A failed turn produces no text, so nothing would otherwise reach TTS and the only trace is a `llm` session error the browser surfaces without a sound. `""` disables. |
| dead-air cover | 5000 ms (`DEFAULT_DEAD_AIR_COVER_MS`) | `pipeline-stream.ts` | Pipeline only: tool execution that sends nothing to TTS for this long gets a `DEAD_AIR_COVER_PHRASES` filler — unlike `holdPhrase` this is time-based, so it still fires after the model has spoken, and repeats across a tool chain with the wait doubling each time. `holdPhrase: ""` disables both. **Must stay above the MEDIAN tool turn**: this is cover for the long-chain outlier, and at 2000 it sat under the ordinary case and fired on 93% of tool turns (EVA airline run, `pretoolspeech_rate` 0.933, tool turns averaging 6.24s), twice on the longest — converting a latency problem into `verbosity_or_filler_rate` 0.38 and `redundant_statements_rate` 0.60. **Cover phrases must also be purely declarative**, never a request for patience: filler goes into an open mic, so "Still working on that." drew "All right, I'll hold" from the caller, which barged in, and the agent was still answering it two turns later after the caller had said goodbye. |
| `falseInterruptionTimeoutMs` | 2000 (`DEFAULT_FALSE_INTERRUPTION_TIMEOUT_MS`) | `constants.ts` | Pipeline only: a partial-triggered barge-in that never commits a user turn (STT noise) resumes the interrupted reply via a synthetic continuation turn after this window. A mid-turn cut resumes from the `[interrupted]` history marker (`DEFAULT_FALSE_INTERRUPTION_PROMPT`); a cut during the client playback tail — the reply finished server-side but was still playing out — resumes with a prompt quoting the estimated last-heard words (`buildTailResumePrompt`), unless less than `TAIL_RESUME_MIN_UNHEARD_MS` of audio was unheard. 0 disables. |
| `maxHistory` | 200 | `constants.ts:52` | Sliding window of conversation messages retained. **The LLM view is trimmed by `capLlm`, not `cap`** (`pipeline-history.ts`): that view holds tool-call/result PAIRS, and an index trim can land between an assistant `tool-call` message and the `tool` message answering it. Both providers reject an unmatched tool result outright (OpenAI: "messages with role 'tool' must be a response to a preceding message with 'tool_calls'"), so every remaining turn of the call failed at the provider and the caller heard `errorPhrase` instead of a reply. Turn sizes vary — 2 messages for a text-only turn, 4 for one tool call, more for a chain — so the window drifts out of alignment with turn boundaries on its own; nothing about the conversation has to be unusual. Only the FRONT is trimmed, so dropping leading `tool` messages is sufficient. A uniform turn size hides the whole class: 4 divides 200, so every trim lands on a turn boundary. |
| resume grace | 120,000 (`SESSION_RESUME_GRACE_MS`) | `constants.ts` | How long a disconnected session's per-session tool state (`ctx.state`) survives awaiting a `?sessionId=<id>` resume — the runtime's stateMap sweep (in-guest on the platform, in-process under `aai dev`) waits it out, cancelled when the session resumes. Sized above the browser client's worst-case automatic-reconnect span (~105s); the client reconnects with the sessionId from the `config` frame, so the resumed session finds its state under the same key. |
| `builtinTools` | `DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) | `constants.ts` | Cognitive built-ins on by default: private reasoning scratchpad, session notes, safe calculator. Set `builtinTools` explicitly (including `[]`) to override. `web_search`/`visit_webpage`/`get_page_design`/`fetch_json`/`run_code` remain opt-in. A custom or relayed tool with the same name wins — the built-in is dropped. |

## Provider sockets disable permessage-deflate

**`ws` defaults `perMessageDeflate` to TRUE on clients and FALSE on servers.**
That asymmetry is the whole gotcha: inbound session sockets
(`WebSocketServer` in `host/server.ts`) decline compression for free, while
every outbound provider socket OFFERS it, and any provider whose server
accepts leaves us holding a zlib deflate+inflate context per socket for the
life of the session. Measured on 200 client sockets exchanging PCM16 frames,
peer accepting vs declining: **+321 KiB RSS per socket** (405 vs 84) and
**~4.5x the CPU** for the same audio (2223 ms vs 491 ms). Pipeline mode opens
two provider sockets per session, so it is paid twice per concurrent call —
more than every other per-session allocation combined, on the one path that
scales with concurrency.

It also buys nothing: these sockets carry PCM16, base64 of it, or an
already-compressed codec. None of that deflates.

So every provider-facing socket spreads `PROVIDER_WS_OPTIONS`
(`host/_ws.ts`) — `defaultCreateHeaderWebSocket` (S2S + OpenAI Realtime),
`providers/tts/rime.ts`, `providers/tts/assemblyai.ts`,
`providers/stt/soniox.ts`. **A new provider that constructs its own `ws`
client must do the same**; `host/_ws.test.ts` pins the wire behaviour against
a server that offers the extension, and the three adapter suites assert the
constructor option.

The vendor-SDK providers (`assemblyai` STT, `@deepgram/sdk`,
`@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`) keep their WebSocket
private and expose no option to pass through, so they are NOT covered — their
compression behaviour is whatever the SDK and the provider negotiate. Worth
re-checking if one of them shows unexplained per-session memory.

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
- **A host client may bring its own provider credentials**, and that is what
  makes a host server safe to expose self-serve. The handshake's `credentials`
  record (keyed by env var name) is merged over the server's env for that one
  connection and WINS on conflict, so a server holding only `AAI_ALLOW_HOST`
  runs every session on the caller's key — an unauthenticated client then has
  no operator credential to spend, because there is none. Substituting a key
  you own is not an escalation: it spends your quota and reveals nothing about
  the operator's. `createHostServer` (`host/host-server.ts`) is that server in
  one call and `examples/host-server` is the runnable shape.

  **`createHostServer` exists because the three-line version was wrong three
  ways.** Standing up a host-only server on `createServer` directly meant
  remembering `AAI_ALLOW_HOST` (a stringly-typed flag guarding the only thing
  the server does), inventing a placeholder `agent()` whose prompt is never
  read just to carry provider descriptors, and hand-rolling a `SessionRuntime`
  facade to decline the plain `/websocket` sessions it cannot serve. The
  wrapper does all three once; `defaults` is the only knob, and it is typed to
  exclude the four fields the handshake owns. Note the placeholder agent was
  never needed even before the wrapper — see the `buildHostAgent` correction
  below.

  **The allowlist is load-bearing, not tidiness.** Names are screened against
  `ALL_PROVIDER_ENV_VARS` — the same vocabulary bounding
  `withHostCredentialFallback`, for the same reason. This record is merged into
  the env the per-connection runtime is built from, and that env is read for
  far more than provider keys: unbounded, a client sets `DATABASE_URL` and the
  server opens `ctx.db` against a Postgres it controls, or sets
  `AAI_ALLOW_HOST` and self-approves. So the gate is checked against the
  SERVER's env before the merge, never the merged one. Unknown names are
  REJECTED by name rather than dropped — a silent drop turns a typo
  (`ASSEMBLYAI_KEY`) into a baffling provider-resolution failure two layers
  down, and turns a genuine smuggling attempt into something the operator never
  hears about.
- **A host session with no base agent runs the DEFAULT PIPELINE, not S2S.**
  `buildHostAgent`'s doc comment claimed the opposite until 2026-08 — it
  predated the pipeline-by-default flip, and S2S has required an explicit `s2s`
  descriptor ever since (see "Never let S2S be a fallback"). With no
  `hostBaseAgent`, `createRuntime` fills all three stages from the
  all-AssemblyAI pipeline, so one caller-supplied `ASSEMBLYAI_API_KEY` covers
  STT, the LLM gateway and TTS. The stale comment had a real cost: it is what
  made a placeholder `agent()` look mandatory on every host server.

- **Host-mode audio pacing is the CLIENT'S declaration, and it defaults to
  paced** (`HostConfig.audioLeadMs`: omitted = the pacer's real-time
  `CLIENT_AUDIO_LEAD_MS`, a number = that lead, `null` = unpaced).

  Unpaced used to be the blanket default, on the reasoning that a host-mode
  client is programmatic and therefore keeps its own clock. That conflates two
  different things: being programmatic does not mean consuming FASTER than the
  wall clock, and only a client whose timeline runs ahead is starved by pacing.
  For a client that drains at 1x it is destructive, because in S2S mode the
  service synthesises a whole reply server-side and it arrives in one burst
  (measured: up to 1118 audio frames in one tau2 tick, against 205 on the
  pipeline transport, whose per-sentence TTS flush paces it inherently). tau2
  plays 200ms per tick and buffers the rest, so the backlog grew to MINUTES — and
  it DISCARDS that buffer on barge-in, so 36% of all agent audio was destroyed
  unheard, p99 181s and max 272s per barge-in on a 215s call, against 18-23% and
  a 15s max for the pipeline arms. The caller heard a fraction of the replies and
  kept asking "are you still there?"; the S2S arm completed a reply for 0.53 of
  caller turns where the pipeline managed 1.00, and 18% of its sessions completed
  no reply at all. Pacing keeps the backlog on OUR side, where
  `PacedAudioSink.clear()` drops it on barge-in instead of handing it over to be
  thrown away.

  So tau2 is not the case unpaced was written for: its `_async_run_tick` enforces
  a MINIMUM tick duration, so it never runs ahead of the wall clock (measured
  mean 315ms per 200ms tick — 0.63x real time). Reach for `null` only for a
  harness that genuinely steps faster than real time.

## Pipeline-transport interleaving fuzz

**`aai` has a randomized interleaving fuzz over the pipeline transport**
(`host/integration/pipeline-fuzz.integration.test.ts`, run by
`pnpm --filter @alexkroman1/aai test:integration`; needs no API keys). The
scripted specs in `host/transports/` each assert ONE interleaving; this drives
random event orderings and checks GLOBAL invariants — turn serialization, no
callback after `stop()`, no write to a closed provider session, reply-text
integrity, no audio after a reply's own `replyDone` — plus the strongest
oracle, validating every LLM request payload the way Anthropic and OpenAI do
(an unmatched `tool` result is a hard 400). That oracle is what surfaced the
`capLlm` bug above. Two rules when extending it: **an oracle must be a
property a real provider or client enforces**, and **the generator must not
itself break a provider contract** — an early draft emitted TTS audio at
arbitrary moments, and the truncation oracle fired on the generator rather
than the transport. It also asserts COVERAGE FLOORS (barge-in, tool
execution, history trimming, reply completion): an all-green fuzz proves
nothing if the random walk never entered the state, so a suddenly greener
result is usually a broken generator, not a fixed bug. Discovery and
regression are separate jobs — findings get a deterministic spec of their own
(the `capLlm` one lives in `pipeline-history.test.ts`), because whether a
random walk reaches a given alignment is luck. That is measured, not assumed:
reverting the `capLlm` fix leaves this suite GREEN (both before and after it
moved to fast-check) while `pipeline-history.test.ts` fails immediately. The
step count carries an unusual `minLength`, because a run spends its first
steps getting the session past `start()` and shorter scripts finish before a
reply ever completes.

- Its generated world (`_pipeline-fuzz-input.ts`) is split from the spec, and
  its request-payload validator from `_pipeline-fuzz-model.ts`, so the spec
  file is the ORACLES and the driver. Note biome's `noSecrets` rule is off for
  `**/_*-fuzz-*.ts` alongside test files (`biome.json`): a camelCase action
  name like `armBargeInFromTool` reads as high-entropy to it, and mangling a
  domain identifier to satisfy a false positive is the wrong trade.
- **Its fatality oracle needed a generator change to mean anything.** "Nothing
  conversational may reach a client that was told the session is over" passed
  on arrival — the fake LLM could not fail a turn, so the state was
  unreachable and the oracle decorative. The script pattern now carries a
  `fail` turn (an `error` stream part) and the instrumented `doStream`
  sometimes refuses outright, which are separate reporters; it then failed at
  once, on `onReplyDone`/`onSpeechStarted` after a fatal `llm` error. Hence
  the floors on `error:llm`, `llmRefused`, and `nonFatal:llm`: the first two
  keep the state reachable, the third turns a regression to `fatal` into a
  failure rather than a silent gap.

## S2S property test

**`aai` has a fast-check PROPERTY TEST over the S2S stack**
(`host/integration/s2s-fuzz.integration.test.ts` plus `_s2s-fuzz-model.ts`,
`_s2s-fuzz-harness.ts`, `_s2s-fuzz-commands.ts`; same command, also keyless).
It differs from the pipeline fuzz twice over — in what it composes, and in how
it generates.

- **The only fake is the SOCKET.** `connectS2s` (wire parse + dispatch),
  `createS2sTransport` (resume, tool-result redelivery, audio suppression) and
  `createSessionCore` (turn lifecycle, tool execution) all run for real, with
  a recording `ClientSink` at the far end. That is the point: every S2S spec that
  predates it stubs out a neighbouring layer (the transport specs mock
  `connectS2s`, the wire specs mock the callbacks), and all three bugs it found
  live in the seam BETWEEN layers, with every layer's own suite green.
- **Model-based COMMANDS, where the pipeline fuzz generates a script.** Both
  are fast-check; the difference is that legality here lives in each command's
  `check()` against a model that IS the provider state machine, so an illegal
  frame is never generated (no audio outside a reply, no `reply.started` while
  the service awaits a `tool.result`) and a counterexample contains only the
  commands that ran. Reverting each of the three fixes reproduces it from
  `[session.error(rate_limited)]`, `[drop.transient, openSocket,
  session.error(session_not_found)]`, and `[drop.transient]` — one, three, and
  one command.
- **No timers anywhere.** Socket opening and tool settlement are COMMANDS, so
  when a tool settles relative to a drop is part of the generated plan rather
  than a race. That is what makes shrinking and replay mean anything: this
  suite's own first draft awaited real `setTimeout`s, could not re-run its
  counterexamples, and intermittently reported a finding no rerun could
  reproduce. It is also why it runs in ~150ms rather than ~50s — the
  per-command drain is a `setImmediate`, not a ~1ms timer.
- **Three properties, differentiated by a per-run `faultBudget`** (0 / 2 / 3):
  turns, reconnects, retirement. One combined property cannot serve both ends
  — at 2 faults per 40 commands a tool call rarely survived to be answered (the
  central oracle ran 7 times out of 80 executions), and at 0 there are no
  resumes to redeliver across.
- Oracles: a tool call the service issued gets exactly one `tool.result` (zero
  leaves the service holding a turn it can never continue — the user hears an
  agent go silent until the idle timeout); nothing conversational reaches a
  client that was told the session is over; at most one fatal `connection`
  error per session, and no socket opened after it; no socket left open after
  `stop()`; `session.resume` only ever names an id the service issued. The
  streaming ones live in the harness's sink and THROW, so fast-check shrinks;
  the end-of-run ones run before `stop()`, which legitimately abandons work.
- **A resumed session inherits the dead socket's unanswered tool calls** —
  that is what `session.resume` MEANS, and it is the premise the tool-answer
  oracle rests on. Stop modelling it and the oracle stops meaning anything.
- **A finding is only reachable if the run does not excuse it first.** The
  tool-answer exemptions (interrupted turn, client reset, retired session, link
  not ready, a SIBLING call of the same reply still running — results flush per
  reply as a BATCH) are broad enough to silence the oracle completely, so each
  increments a `skip:<why>` counter and the floors are on the CHECKED counts.
  `toolAnsweredAcrossResume` has been near zero through three separate
  mistakes; it is the floor that stands between a live oracle and a decorative
  one. `S2S_FUZZ_COVERAGE=1` prints the table.
- **The fakes' fidelity is where the false findings came from**, every time.
  Three drafts blamed the transport for behaviour their own fake had invented:
  a `executeTool` that ignored its abort signal (the real one settles promptly
  via `pTimeout({ signal })`, so `stop()` was reported as hanging forever), one
  that ignored an ALREADY-aborted signal (which is exactly what a `tool.call`
  after a client cancel receives, since `onCancel` aborts the reply without
  replacing it), and one that rejected where the real executor always RESOLVES
  with a `toolError(...)` string. Check the real collaborator's contract before
  believing a finding.

## Fixture replay testing (`host/`)

Tests in `packages/aai/host/` use a **hybrid mock** pattern: a real
`Runtime` and tool executor with mocked S2S WebSocket connections. JSON
fixtures in `host/fixtures/` contain recorded AssemblyAI API messages
that are replayed through the real orchestration layer. Key helpers:

- `makeMockHandle()` — creates mock S2S WebSocket using nanoevents
- `replayFixtureMessages()` — dispatches fixture JSON as typed events
- `createFixtureSession()` — wires a real Runtime to mocked S2S

## One canonical config schema, deny-list boundaries

**One canonical config schema, deny-list boundaries.** The dropped-field bug
family (`builtinTools` — deployed agents silently lost the default cognitive
builtins; `send`; the provider triple) all came from
allow-list mappers re-declaring the config field list, where every field is
optional and an omission is valid TypeScript. Every such bug presents as a
*working* agent quietly ignoring part of its own config. The design is now
inverted — one canonical serializable schema flows CLI → server → runtime
unchanged, and each boundary subtracts an explicit deny-list instead of
copying fields:

- **`AgentConfigSchema`** (`sdk/_internal-types.ts`) is the canonical shape.
  `toAgentConfig` strips `HOST_ONLY_AGENT_FIELDS` (`tools`, `state`) plus
  undefined values and validates through the schema — no per-field copies.
  `_internal-types.test.ts` asserts the one subtraction:
  `Exclude<keyof AgentDef, keyof AgentConfig | HostOnlyAgentField>` is `never`.
- **`agent()`** derives its parameter shape from `AgentDef`
  (`AgentParams` = `Omit` + `Partial<Pick>` of the defaulted fields) plus
  three author-only conveniences `agent()` normalizes away (`system` as an
  alias of `systemPrompt`, `llm` accepting a gateway model-id string —
  `sdk/providers/llm/from-string.ts` — and `voice` desugaring to
  `tts: assemblyAITts({ voice })`), instead
  of re-declaring it inline — the inline form is how `send` and `state`
  shipped as runtime-working but excess-property errors for authors
  (neither bundler typechecks user code). `define.test-d.ts` locks this.
- **`IsolateConfigSchema`** (`aai-server/rpc-schemas.ts`) is
  `AgentConfigSchema.extend({...})` — the extensions are wire-tolerance
  loosenings, wire defaults, and the wire-only `toolSchemas`; none may drop
  a field. It runs at **deploy time only** (`validateAgentConfig`), on the
  current CLI's freshly extracted config.
- **Stored configs are FULLY OPAQUE on reads** (`StoredAgentConfigSchema` in
  `aai-server/agent-store.ts` — a bare record): the host has NO field-level
  reader left. Even the broker's `name`/`greeting` are PROXIED from the
  guest's own `/client-config` (the bundle's live agent definition,
  interpreted by the bundle's own SDK — see client-config-handler.ts), so a
  platform schema change can never re-interpret a deployed agent. A stored
  config is never re-validated against a newer schema, so tightening
  `IsolateConfigSchema` cannot 404 previously-valid deployed agents.
  Never add fields or refinements to the stored schema — strictness belongs
  at the deploy boundary.
- **The server never maps a stored config onto a runtime agent.** The old
  `toRuntimeAgent` boundary (`sandbox-agent-config.ts`) is gone with platform
  host mode — sessions run the bundle's own SDK on the bundle's own agent
  definition, so there is no server-side config→agent mapping left to drop
  fields at. (Historical context, kept because the bug class recurs: provider
  descriptors must be keyed off their own presence, never the optional
  `config.mode` — a config carrying all three providers with no `mode` once
  hit a `config.mode === "pipeline"` gate and lost every one of them, so the
  runtime resolved S2S and ran a healthy S2S session on the agent's own key,
  nothing logged. `superRefine` still rejects a `mode` that disagrees with
  the descriptors.) `rpc-schemas.test.ts` asserts the remaining subtraction:
  `Exclude<keyof AgentConfig, keyof IsolateConfig>` is `never`.

A new serializable agent field therefore needs exactly two edits — `AgentDef`
(docs + type) and `AgentConfigSchema` (shape) — and the type guards fail
loudly if either half is missing; no mapper edits, and the field reaches the
server, the wire, and the runtime by default.

**Never let S2S be a fallback.** The pipeline-by-default flip closed most of
this structurally: a config that loses its providers now gets the AssemblyAI
pipeline injected (`defaultProviders`), not a silent S2S session, and S2S
requires an explicit `s2s` descriptor. There is no fallthrough left —
`buildTransport` (`host/runtime-transport.ts`) throws on a descriptor-less
config whose pipeline providers didn't resolve (the pre-flip legacy fallback
to `buildAssemblyS2sTransport` was removed). Two rules keep mode
diagnosable: forward providers based on their own presence (above), and
`createRuntime` logs `"Session mode resolved"` once per runtime with the mode
and provider kinds — "which transport is this agent on" must be answerable
from one log line rather than inferred from the shape of the message stream
(`S2S <<` prefixes).
