# packages/aai — SDK guide

The shared core SDK (`@alexkroman1/aai`). Repo-wide commands, conventions,
testing rules, and the changeset/PR workflow live in the root `CLAUDE.md`;
platform behaviour lives in `packages/aai-server/CLAUDE.md`.

## SDK structure

The SDK is organized into two directories with a **hard dependency boundary** —
this split is critical for sandbox security:

- **`sdk/`** — shared modules with **zero Node.js dependencies**. Safe to run in
  browsers, Deno, and sandboxed environments: the types, the wire protocol, the
  canonical serializable config (`agent-config.ts` + `toAgentConfig`), Standard
  Schema acceptance (`schema.ts`), the `agent()`/`tool()`/`sessionSlot()`
  authoring helpers (`define.ts`, `session-slot.ts`), the provider DESCRIPTOR
  factories, and the concurrency primitives above.
- **`host/`** — host-only modules that **require Node.js APIs** (`node:vm`,
  `node:crypto`, …). Only runs on the platform server and CLI, never inside a
  guest sandbox: `server.ts`, `runtime*.ts`, `session-core.ts`, `s2s.ts`,
  `ws-handler.ts`, `tool-executor.ts`, `builtin-tools.ts`, `postgres-db.ts`,
  `telephony/`, `providers/` (the STT/TTS openers and the descriptor→instance
  resolvers), and `transports/` — the S2S / pipeline / OpenAI Realtime
  `Transport` implementations, including `pipeline-turn-outcome.ts` (the three
  ways a pipeline turn ends: interrupted by barge-in, failed, or spoken) and
  `pipeline-transport-lifecycle.ts`, the once-per-CALL half of pipeline mode
  split from the turn orchestration on exactly the line "a failing TURN is not a
  failing SESSION" draws.

**Rule**: When adding new SDK code, place it in `sdk/` if it has no `node:`
dependencies. Moving code from `sdk/` → `host/` is safe; moving `host/` →
`sdk/` requires removing all Node.js imports first.

The guest harness (`packages/aai-guest/harness.ts`) runs **Node** inside each
Modal Sandbox — the same runtime as the host and `aai dev` — loading the agent's
ESM bundle directly; the Modal sandbox (not a language runtime permission model)
is the security boundary.

## Package exports

Fifteen subpaths, mapped file-by-file in the table below. What decides which
one a symbol lives on:

### The root barrel is CURATED, and `export *` is what broke it

`index.ts` re-exports eight modules wholesale and two — `sdk/constants.ts` and
`sdk/utils.ts` — **by name**. Those two are the repo's SHARED modules (every
magic number; the zod-free helpers the CLI loads on every invocation), so a
wildcard put a jitter-buffer depth, a WebSocket close code and the platform's
slug regex in an agent author's autocomplete beside `greeting`. Measured before
the split: **175 exports, 71 of them `@internal`, and 160 unused by any of the
fourteen templates** — eleven symbols covered every one. It is 92 now and
**none is `@internal`**, which is the property to preserve.

The membership test for anything added later: **a symbol belongs here if an
`agent.ts`, a tool module, or a `workflow()` would NAME it.** A budget the
framework enforces on its own does not qualify however public it is —
`DEFAULT_MIN_BARGE_IN_WORDS` stayed because it documents `minBargeInWords`,
`PLAYBACK_FILL_MS` did not because no field sets it. Nothing was deleted:
budgets went to `./internal`, the slug/CLI contracts and wire helpers stay on
`./utils`, and `StandardSchemaV1` and its result/issue types stay in
`sdk/schema.ts` — the ecosystem SPEC `tool()` accepts, not something an agent
declares.

## Subpath export → file mapping

Tracing imports through barrel files can be confusing. Here's the map
of subpath exports in `aai/package.json`:

| Import path | Resolves to | What it contains |
| --- | --- | --- |
| `@alexkroman1/aai` | `packages/aai/index.ts` | The AUTHORING surface, and only that: `agent()`/`tool()`/`sessionSlot()`/`workflow()`, the types they take and return, `assemblyAIPipeline()`/`assemblyAIS2s()`, and the `DEFAULT_*` constants that document an `agent()` field. Eight modules by `export *`, plus NAMED subsets of `sdk/constants.ts` and `sdk/utils.ts` — see "The root barrel is CURATED" above |
| `@alexkroman1/aai/testing` | `sdk/testing.ts` (direct) | Test helpers for an agent author's OWN project, which is why they are published and why the module carries no test-runner dependency. `createToolContext(overrides?)` builds a full `ToolContext` with inert defaults, a recording `send` (`ctx.sent`) and a distinct `sessionId` per call; `createUnusedDb()` / `createStubWorkflows()` are the rejecting `db`/`ctx.workflows` it defaults to. Then the fakes a tool's COLLABORATORS are driven by — `stubGenerate`, `stubGateway`/`stubUploads`, `createRunSnapshot`/`createProgressStream`, and `toolOf`/`runTool` for reaching a tool by the name the model calls it by. **`withDiscoveredTools(def, modules)`** is the one a project whose tools are FILES cannot do without: `agent.ts`'s default export carries only the INLINE tools, so a spec passes `import.meta.glob("./tools/*.ts", { eager: true })` and gets the def a DEPLOYED agent runs — it takes the glob's RESULT rather than a directory (`import.meta.glob` is expanded against the file containing it and cannot take a variable), and a `readdir` + `import()` is refused because it resolves the tools through Node instead of the test runner and hands them a second copy of this SDK. Each helper's own doc carries the rest; see the `_test-utils.ts` section of the root guide |
| `@alexkroman1/aai/testing/vitest` | `sdk/testing-vitest.ts` (direct) | `installStubGateway(replies, opts?)` — the fake above, installed as the global `fetch`, returning its call log. The one place a test-runner dependency is allowed, so the rule the subpath above states stays true: `vitest` is an OPTIONAL peer, and importing THIS is what pulls it. A helper belongs here only when its remaining content is the installation — the fake itself stays framework-agnostic next door |
| `@alexkroman1/aai/utils` | `sdk/utils.ts` (direct, not a barrel) | The zod-free half of the SDK, which is what makes it the CLI's import path — **the module doc owns that rule**, including why `omitUndefined` lives here rather than on `/internal` and why `createKeyedLock`'s `p-timeout` (2.4 KB, no dependencies) is the one measured exception. Four groups: the tool-code helpers the root also re-exports (`errorMessage`, `errorDetail`, `safeJsonParse`, `toolFailure`/`isToolFailure`, `pushCapped`, `createKeyedLock`/`withLock`); the STEP surface, which a `workflows/*.ts` module imports from HERE rather than the root because it is bundled separately and the root barrel's graph would ride into the step bundle — `mapConcurrent`, `report`/`emit`, `stepEnv`/`requireStepEnv`, `stepGenerate` (one `fetch` to the LLM gateway on the agent's own key, since the AI SDK would be megabytes in a ~7 KB artifact), `stepGenerateJson`/`stripJsonFence`, and **`stepFetch`** + `multipartBody` (HTTP/1.1-pinned: `fetch` speaks h2, and a fan-out on one connection turns a rate limit into an unreadable stream reset); the helpers every package reaches for and no template names, so they stay off the root — `omitUndefined` and **`isRecord`**, which `typeof v === "object" && v !== null` was open-coded twelve times to spell, each site paying twice because that check narrows to `object` where every field read is an error (`guard-invariants` rule 17 keeps copy thirteen out; arrays are excluded because every caller reads a NAMED field); the framework's own wire helpers, `@internal` and root-invisible (`capToolResult`, `toArgsRecord`, `isTextAssetPath`, `normalizeSpeechText`, and `serializeToolFailure` — the pre-serialized `'{"error":…}'` the host emits for a tool that threw, which `isToolFailure` deliberately does NOT narrow); and the two contracts BOTH ends of a platform interaction must derive identically — the slug shape (`VALID_SLUG_RE`, `RESERVED_SLUGS`, `sdk/slug.ts`) and the `aai login` confirmation code (`linkConfirmationCode`, `sdk/cli-link.ts`) |
| `@alexkroman1/aai/step-errors` | `sdk/step-errors.ts` (direct) | `toStepError`/`throwStepError`/`throwFatalStepError` — the failure a `"use step"` body throws, classified into the DevKit's `FatalError`/`RetryableError`. Its own subpath because it is the one authoring module importing `workflow`, which `/utils` may not; the module doc carries the rest |
| `@alexkroman1/aai/slugify` | `host/slugify.ts` (direct) | `slugifyName` — how a human name BECOMES a slug (transliterating, `decamelize: false`), for the CLI, the platform server, and the studio. Separate from the contract in `sdk/slug.ts` on purpose: that one is dependency-free and rides every agent bundle, this one pulls the transliteration tables. Nothing on the SDK hot path may import it |
| `@alexkroman1/aai/runtime` | `host/runtime-barrel.ts` → 11 modules | Full Node.js runtime: session, S2S, server, tools, WS handler |
| `@alexkroman1/aai/workflow-api` | `sdk/workflow-api-client.ts` (direct) | `createWorkflowApiClient` plus `WORKFLOW_API_PREFIX` — the CLIENT of the workflow HTTP API `host/workflow-api.ts` serves, shared by the browser client, the CLI and the studio; its module doc carries why |
| `@alexkroman1/aai/protocol` | `sdk/protocol.ts` (direct, not a barrel) | Wire-format Zod schemas, `lenientParse()`, `ClientEvent`, `ServerMessage` |
| `@alexkroman1/aai/manifest` | `sdk/manifest-barrel.ts` → 3 modules | `toAgentConfig()`, `agentToolsToSchemas()`, `AgentConfig`/`ToolSchema` + their Zod schemas, config-rule asserts. (The subpath name is historical — the old `parseManifest()`/`Manifest` layer was deleted; renaming the published subpath wasn't worth the break.) |
| `@alexkroman1/aai/stt` | `sdk/providers/stt-barrel.ts` | STT provider factories + types (`assemblyAIStt`, `deepgram`, `elevenlabs`, `soniox`) |
| `@alexkroman1/aai/llm` | `sdk/providers/llm-barrel.ts` | LLM provider factories + types (`anthropic`, `openai`, `google`, `mistral`, `xai`, `groq`, `openrouter`, `gateway`) |
| `@alexkroman1/aai/tts` | `sdk/providers/tts-barrel.ts` | TTS provider factories + types (`cartesia`, `rime`, `assemblyAITts`) |
| `@alexkroman1/aai/s2s` | `sdk/providers/s2s-barrel.ts` | S2S provider factories + types (`openaiRealtime`; `assemblyAIS2s` is on the root export) |
| `@alexkroman1/aai/tools` | `host/agent-tools.ts` (direct, not a barrel) | Keyless network builtins callable from user tool code: `fetchJson`, `visitWebpage`, `webSearch`. All three ANSWER `T \| ToolFailure` — a builtin's failure is its result, not a throw — so a caller that names a shape narrows with `isToolFailure`. Typed as a bare `T`, all three callers in this repo turned a live DuckDuckGo 403 into "the web has nothing" |
| `@alexkroman1/aai/internal` | `internal.ts` | Cross-package infrastructure (`createEpoch`, `createOwnedMap`, `createCoalescingRunner`, `parseWsUpgradeParams`, `formatSchemaIssues`) plus the framework BUDGETS the browser client needs (the client-audio constants, `AGENT_CSP`, `WS_OPEN`). Not public API, not semver-covered, excluded from the docs. The env brands live on `./runtime` instead — they appear in its public signatures (`RuntimeOptions`, `withHostCredentialFallback`) |

## Session modes

Each agent runs in one of three session modes, selected by `toAgentConfig()`
(run in the generated bundle entry) based on which top-level fields are
present in the `agent()` config:

- **Text mode** (explicit opt-in — `text: true`) has no audio path at all: an
  LLM, a system prompt and the agent's tools, run over a message list by
  `createTextAgent` rather than by a transport over a socket. Explicit for the
  same reason `s2s` is, and the two modes refuse each other by name. **See
  `host/text-agent.ts`'s module doc**; this guide is at its cap and the rest
  of the rule lives there.
- **Pipeline mode** (the DEFAULT — all three of `stt`, `llm`, and `tts`
  set, or none of the four provider fields set, in which case the
  all-AssemblyAI pipeline (`assemblyAIPipeline()`) is injected by
  `defaultProviders` in `sdk/providers/_default-providers.ts`) uses
  `createPipelineTransport()` in
  `packages/aai/host/transports/pipeline-transport.ts`. Here the host
  drives the LLM loop itself via the Vercel AI SDK's `streamText`, and STT
  and TTS are pluggable providers imported from the `@alexkroman1/aai/stt`
  and `@alexkroman1/aai/tts` subpath exports.

  **A failing TURN is not a failing SESSION.** `onError` defaults to
  `fatal: true`, and aai-ui answers a fatal frame by releasing the microphone
  and ending the call — so only the two paths that really terminate may report
  that way, and every turn-level reporter passes `{ fatal: false }`.
  **`transports/pipeline-error.ts`'s module doc owns the rule**, both
  terminating paths, all three turn-level reporters, why reporting the LLM ones
  as fatal was especially perverse, and which of them the pipeline fuzz covers
  against the one that needs a deterministic spec.

- **S2S mode** (explicit opt-in — `s2s: assemblyAIS2s()` from the main
  export, or `openaiRealtime()` from `@alexkroman1/aai/s2s`) uses
  `createS2sTransport()` in `packages/aai/host/transports/s2s-transport.ts`.
  The host opens a single WebSocket to AssemblyAI's speech-to-speech
  service; STT, the LLM loop, and TTS all run service-side and audio/events
  relay through that one socket. There is no way to reach S2S by omission —
  only the `s2s` descriptor selects it.

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

  Row one is the whole problem: relabelled audio produces no error at all, so
  the agent greets normally and is then permanently deaf. **Why that is silent,
  why `S2SConfig.inputSampleRate` cannot simply be changed, and why pinning the
  rate is necessary and NOT sufficient are in the module docs that own the
  mechanism** — `ASSEMBLYAI_S2S_SAMPLE_RATE` in `sdk/constants.ts` and
  `pinAssemblyS2sRates` in `host/runtime-config.ts`, which also record the 2/25
  tau2 run measured with the pin in place. The counterpart the pin cannot
  reach is `assertHostRatesSupported` (`host-mode.ts`), which REJECTS a
  host-mode handshake declaring a rate this transport cannot honour.

  Two numbers those docs do not carry. That 2/25 was against **15/25 and 18/25
  for the two pipeline transports running the same tasks at the same minute**,
  which is what makes it a transport finding rather than a bad afternoon. And
  **the host does not resample, deliberately.** A resampler was built and
  reverted: it worked (16 kHz converted to true 24 kHz transcribed correctly
  5/5 live, against 4/5 returning nothing when relabelled), but upsampling can
  only preserve or degrade — it invents no bandwidth — and it put ~150 lines of
  stateful DSP in the hot audio path to paper over a client that could simply
  send the right rate. Every client already owns its own rate conversion: the
  browser's WebAudio does it, tau2 resamples from 8 kHz μ-law regardless, so
  making it 8→24 costs nothing. Rate conversion belongs at the edge; the host's
  job is to state the requirement and refuse a client that will not meet it.

  **S2S has no agent captions on tool-call turns, and `transcript.agent.delta`
  is the remedy.** Neither reply of a tool-call turn emits `transcript.agent`, so
  a tool-using agent renders blank reply text for exactly the turns that do the
  work — measured against the live service, and the vendor's own docs contradict
  each other on whether it is intended. The per-word deltas DO arrive (511 frames
  over one 215s session; this guide asserted the opposite for a while), and
  `s2s.ts` forwards them as a partial and commits them on a COMPLETED reply that
  sent no final — never on an interrupted one, which would put words in history
  the caller never heard. **Read `host/_s2s-reply.ts`'s module doc** for both
  measurements, the two properties that decide how the deltas are consumed, and
  the anomaly log; this guide is at its cap and that module owns the finding.

  **S2S sends Voice Focus, `sttPrompt`, and the three descriptor options
  (`voice`, `languages`, `keyterms`).** `updateSession` pins
  `input.voice_focus`/`voice_focus_threshold` from the same
  `DEFAULT_VOICE_FOCUS`/`DEFAULT_VOICE_FOCUS_THRESHOLD` constants the pipeline
  STT stage reads (the S2S default is the service's 0.7, and the interferer that
  matters is background speech), and forwards `sttPrompt` as
  `input.transcription_prompt`, trimmed to that field's documented 1750-char cap
  — keeping the HEAD, unlike `agent_context`'s tail-keeping trim, because this is
  a standing vocabulary description rather than a trailing question.

  `sttPrompt` was pipeline-only until 2026-08-06 — a SILENT config drop of
  exactly the class this guide warns about, since both `agent({ sttPrompt })`
  and `host.sttPrompt` reached the agent definition and only
  `pipeline-transport.ts` read it. **That fix then landed the runtime half and
  left the TYPE half closed for three days**, which is worth more than the bug
  was: `PipelineOnlyField` still listed `sttPrompt`, so `agent({ s2s,
  sttPrompt })` was a compile error naming a rule that was no longer true while
  `AgentDef.sttPrompt` documented the field as working in both modes and the
  transport forwarded it — the only way to reach the measured win was to skip
  `agent()` for a raw `export default {...}`. A dropped field has a mirror image
  — a REJECTED field the runtime honours — and it reads to an author as
  "unsupported", so it draws no bug report at all. **When a config field's mode
  rule changes, the type gate, the doc, and the transport all move together or
  none of them do.** `runtime-transport.test.ts` pins the forwarding at the
  point it was missing.

  `input.language_codes`, `input.keyterms` and `output.voice` are reachable as of
  2026-08-09: `assemblyAIS2s()` takes `{ voice, languages, keyterms }`, read off
  the stored descriptor by `readAssemblyS2sOptions` in `runtime-transport.ts` and
  forwarded on presence only. Before that the factory took no options at all, so
  an S2S agent could not pick its voice — which is why the claim elsewhere in
  this guide that "S2S mode's voice rides on the `s2s` descriptor" was wrong when
  written and is now merely how it works. **`AssemblyAIS2sOptions`
  (`sdk/providers/s2s/assemblyai.ts`) owns the rest** — the tau2-bench retail
  measurement behind the three settings (spelled first name 1/6 -> 6/6, word
  recall ~0.89 -> ~0.93), why `languages` must stay AUTHOR-controlled rather than
  defaulted, why an unverified `voice` id leaves an agent that connects, reports
  ready and never speaks, and why `turn_detection` is deliberately not pinned.

  **An in-band service error is NOT the end of the session, and a fatal frame
  is not a banner.** An `error.reported` with no `fatal` key means the session is
  over, and aai-ui answers one by calling `cleanupAudio()`, bumping the
  connection generation and setting `running: false` — the MICROPHONE IS
  RELEASED. Both S2S transports used to report every in-band error that way
  (AssemblyAI's `session.error` with a non-expiry code, its bare `error` frame,
  OpenAI Realtime's `error` event), and none of those closes the socket: the
  conversation demonstrably continued — `tool_call`, `reply_done` and audio all
  arrived afterwards on most fuzz seeds — to a client that could no longer hear
  anyone, and a later event even recovered its state to "listening"
  (`clearRecoveredError`), leaving a session that looks live and is deaf. They
  now pass `{ fatal: false }`; the *only* reporter of session death is the
  close/failed-resume path (`endSession`), which is the one place that knows the
  link is gone and attaches the close code. A truly terminal error is still
  covered, because the service closes the socket after it. Note session-core logs
  a non-fatal error at DEBUG, so `s2s.ts` logs the `error` frame's message itself
  at warn — demoting the client-facing severity must not also make the service's
  complaint invisible.

  **Retiring the session must also DROP THE LINK** (`endSession`). Most fatal
  paths arrive from a close, where the socket is already gone — but not all: when
  the service rejects a `session.resume` with `session_not_found` it says so IN
  BAND and leaves the socket OPEN, so the transport went on holding a live
  (billed) provider session and relaying its frames to a client it had just told
  the call was over. `endSession` closes the socket, drops the handle and the
  queued tool results, and the inbound callbacks are gated on the session still
  being live (`whileLive`) — `close()` does not un-deliver what is already
  buffered.

  **`stop()` must be able to abandon a handshake that has not completed**
  (`ConnectS2sOptions.signal`, aborted by the transport's `teardown` controller).
  `handle?.close()` can only reach a socket that OPENED: `connectS2s` returns a
  handle only on `open`, and `ws` sets no `handshakeTimeout`, so a client that
  hung up mid-resume left a half-open (billed) provider connection pinned for the
  life of the process, with nothing anywhere holding a reference to close. A
  connect that loses this race is swallowed rather than reported: we aborted it,
  and there is no session left to fail. All three of these came out of the S2S
  property test, which shrank the last one to two commands: `session.ready`, then
  a transient drop.

The default injection runs at every mode-derivation site
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

- **Pre-connection client config**: the default client page is byte-identical
  for every agent and the CSP bars inline scripts, so the agent's display name
  and greeting reach the browser via a pre-connection endpoint —
  `GET /client-config` (dev server) / `GET /:slug/client-config` (platform,
  unauthenticated, for parity with the page and the WebSocket) returning
  `{ name, greeting }` (`sdk/client-config.ts`, re-exported from `/protocol`).
  **Every server builds the body through one helper**, `buildClientConfig`; on
  the platform (`aai-server/client-config-handler.ts`) name and greeting are
  PROXIED from the GUEST'S own `/client-config` — the bundle's live agent
  definition — never read from the stored config, which is fully opaque to the
  host. A guest that can't answer degrades to `{ sessionUrl }` only, and the
  `aai dev` Vite proxy forwards `/client-config` to the backend.
- **What the BROWSER client does with all of that** — the `DefaultRoot`
  config tier, the `serverIsBroker` latch that must only be set by an
  ANSWERED lookup, and why `ApiUrlChip` shows the long-living platform
  endpoint rather than the sandbox tunnel — is in
  `packages/aai-ui/CLAUDE.md`, "Consuming the client config".

Reference providers shipped today:

- **STT**: one of
  - `assemblyAIStt({ model: "universal-3-5-pro" })` — `ASSEMBLYAI_API_KEY`
  - `deepgram({ model: "nova-3" })` — `DEEPGRAM_API_KEY`
  - `elevenlabs({ model: "scribe_v2_realtime" })` — `ELEVENLABS_API_KEY`
  - `soniox({ model: "stt-rt-v3" })` — `SONIOX_API_KEY`

  **Never inherit the `assemblyai` SDK's connect deadline.** Its default
  `connectTimeout` is 1000 ms and covers far more than a socket open, so a
  healthy link still blows it and the session dies on a fatal
  `stt_connect_failed` that reads as a provider outage.
  `host/providers/stt/assemblyai.ts` therefore always sets
  `connectTimeout`/`maxConnectionRetries`/`connectionRetryDelay` from
  `STT_CONNECT_*`, overridable per agent via
  `assemblyAIStt({ connectTimeoutMs, maxConnectRetries })`. **Those three
  constants' shared doc in `sdk/pipeline-tuning-constants.ts` carries the
  argument** — what the SDK's timer really covers, and the 8500 ms < 10000 ms
  arithmetic against `DEFAULT_SESSION_START_TIMEOUT_MS` that `assemblyai.test.ts`
  asserts. Re-check that sum before raising any of them.

  Two descriptor options whose rules are stated on the options themselves
  (`AssemblyAIOptions` in `sdk/providers/stt/assemblyai.ts`) rather than
  restated here: **`streamingUrl`**, which overrides the streaming endpoint and
  WINS over `region` (it must carry the versioned path — a bare origin connects
  to the wrong route), and **`languages`, whose unset value is "detect per
  turn", NOT "English"** — the doc records the measurement where that default
  transliterated English into Devanagari and Hebrew script and made the tool
  arguments garbage while every transcript read as an ordinary mis-hearing. It
  stays UNSENT when absent: a host-side default would silently disable
  multilingual transcription for every agent, which is the mirror-image bug.
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
    endpoint. The client is built with a `fetch` wrapper,
    `repairOpenAiStream` — the gateway documents streamed responses for OpenAI
    models only, and its Claude streams break two AI SDK expectations, each
    fatal to a turn. **Both defects, and why bytes are the only place they can
    be caught (so this is a `fetch` wrapper rather than middleware), are in
    `host/providers/_openai-stream-repair.ts`'s module doc.** A THIRD defect is
    a REQUEST one (Gemini 500s on the `$schema`/`propertyNames` zod conversion
    emits) and is `transformParams` middleware instead —
    `_gateway-tool-schema.ts` carries why. Remove each once the gateway
    conforms.

    **The default model is `qwen3-next-80b-a3b`, and check the constant before
    trusting this line** — it has named the wrong model before, when an id was
    reverted in code and not here. `ASSEMBLYAI_LLM_DEFAULT_MODEL` in
    `sdk/providers/llm/assemblyai.ts` is the answer; a prose default is only a
    claim about it. Changing the id moves WHERE reasoning gets turned off,
    because `TOOLS_REQUIRE_NO_REASONING` in that same module is keyed by model
    id: **on the `gpt-5.6` family `reasoning_effort: "none"` is REQUIRED for
    tool use, not a tuning knob**, and the factory fills it in for those ids
    only. **That constant's doc carries the gateway's own rejection message,
    the 4/4 measurement behind it, why the streaming path sees a bare 500
    instead, and why an explicit `reasoningEffort` is left alone.** Read it
    before changing the default. One thing it does not say: the generated
    catalog (`gateway-models.ts`) cannot carry the flag — its flags come from
    `supported_parameters`, which does not list `reasoning_effort` for ANY
    model, including ones that plainly honour it (a bogus value 400s naming the
    supported ones). `gpt-5.5` and `qwen3-next-80b-a3b` are both unaffected,
    measured 2026-08-06: `"none"`, `"low"`, and no `reasoning_effort` at all
    each return a normal tool-calling completion, streaming included.

    **`assemblyAIPipeline()`'s explicit `reasoningEffort: "none"` is, on the
    current default, the ONLY thing turning reasoning off.** Because
    `qwen3-next-80b-a3b` is OUTSIDE `TOOLS_REQUIRE_NO_REASONING`, the factory
    fills in nothing and the whole weight sits on the preset's argument
    (`sdk/providers/assemblyai-pipeline.ts`); under `gpt-5.6-luna` or
    `gpt-5.6-terra` the factory fills the same value and the argument merely
    agrees with it. That agreement is a property of the id, not of
    the pipeline, which is why the argument stays under either: deleting it as
    redundant costs every
    default pipeline **1786ms p50 time-to-first-token against 999ms with
    reasoning off**, with seconds of pre-first-token silence rather than a
    failure as the symptom. So the two settings are pinned TOGETHER in
    `define.test.ts` (effort and model id in one test): the preset's `"none"`
    is what makes the next id change safe, and the pin is what makes an id
    change that needs a second look fail loudly.

    **The measured case is for `gpt-5.6-luna`, and it does not transfer to
    either the current default or terra.** What is known about
    `qwen3-next-80b-a3b` directly: the gateway advertises it with tools,
    streaming, 200k context and a live probe (`gateway-models.ts`), it accepts
    `reasoning_effort` as a hybrid-thinking model (`"none"` and `"low"` both
    verified 2026-08-06), and it has **no paired latency numbers and no price
    comparison here at all** — the same gap terra had. Luna's numbers, kept
    because they bound the gpt-5.6 family: $1/$6 per M against `gpt-5.5`'s
    $5/$30, and time-to-first-token (2026-08-06, 18 paired tool-calling turns,
    `reasoning_effort: "none"` on both) p50 **832ms vs 999ms** — ~17%, against
    `claude-opus-4-8`'s 1217ms and `claude-sonnet-5`'s 1568ms. The 5x-looking
    gaps in the first measurements were an ARTIFACT of comparing
    luna-with-`none` against `gpt-5.5` on its reasoning DEFAULT (1786ms): most
    of what looked like a model difference was the reasoning setting, which
    this pipeline turns off regardless of model.

    **No default here has been chosen on answer quality**, which is the axis
    that should decide one — a tau2 run is what would settle it. The current
    default has neither paired latency numbers nor a quality run, and neither
    did terra. Treat it as unverified on both axes.
- **TTS**: one of
  - `cartesia({ voice })` — `CARTESIA_API_KEY`
  - `rime({ voice })` — `RIME_API_KEY`
  - `assemblyAITts({ voice, language? })` — `ASSEMBLYAI_API_KEY`; AssemblyAI's
    streaming TTS over `wss://streaming-tts.assemblyai.com/v1/ws/`. Sharing one
    key with STT and the gateway means an all-AssemblyAI pipeline needs exactly
    one secret. **`host/providers/tts/assemblyai.ts`'s module doc owns the
    protocol** — the raw-key (not `Bearer`) auth and why a rejected key surfaces
    as `tts_stream_error`, why the adapter must not block waiting for `Begin`,
    the frame vocabulary, and the measurement behind the one thing that decides
    whether the agent feels responsive: **`Generate` only buffers — `Flush` is
    what starts synthesis.** Relaying LLM deltas and flushing once makes
    time-to-first-audio the length of the whole turn, since the pipeline's only
    provider-level flush is the end-of-turn drain (`flushTtsAndWait`, once per
    reply); a tool-chaining reply was silent for its entire duration, the
    dead-air cover included, as filler is just more buffered text. The adapter
    therefore buffers host-side and emits `Generate`+`Flush` **per segment** — a
    sentence end, or **40 characters** when no sentence end is in sight
    (`splitSegment` in `host/providers/tts/assemblyai-segment.ts`).

    **Segment LENGTH is the knob, not flush count, and it has a cliff on both
    sides** — "stream continuously" is not available on this protocol at any
    useful quality. **`host/providers/tts/assemblyai-segment.ts`'s module doc
    owns the whole curve**: the three measured segmentations, the per-3-word
    collapse, the `WordBoundaries` frames that name the ~800ms padding slot
    behind it, why the budget is a floor-BREAKER rather than a cap, and why the
    two-word floor exists. Read it before touching either constant.

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

**Reach for `createSttSessionShell` / `createTtsSessionShell`, not
`createSessionShell` directly.** The raw factory also takes `cleanCloseIsFatal`,
which is a per-STAGE invariant rather than a per-provider choice (see its doc:
fatal for a continuous INPUT stream, normal completion for an output one). Seven
openers restated the same three lines, which made a session-deafening default
one copy-paste away. Two more rules the openers must not re-derive:
**`shell.emit` / `shell.on` are the ONLY path to an opener's emitter**
(`host/providers/_utils.ts`) — the shell owns the closed latch and the try/catch,
because these fire from inside a raw socket handler where a throw from a
downstream listener escapes into Node's `EventEmitter` as an uncaughtException
and takes down a multi-tenant host; it was `safeEmit(...)` applied in two openers
of seven. And **`openGuardedWs` (`host/providers/_socket.ts`) is the only way to
open a raw provider WebSocket**, carrying the connect deadline
(`WS_OPEN_TIMEOUT_MS`, 8000, kept under `DEFAULT_SESSION_START_TIMEOUT_MS` so the
failure names the provider) and the pre-connect zero-listener `error` guard —
without it a black-holed connect leaves `providers.open()` pending forever on a
socket with no owner, and a later socket `error` with no listener bound crashes
the host. Both module docs carry the rest.

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

## An upload's bytes are OBJECTS, and its record has two homes

One store (`host/_upload-store-blobs.ts`) over two interfaces — `UploadRecords`
for the record, `UploadBlobs` for one object per `UPLOAD_PART_BYTES` window — and
it names neither's home. It used to hold the bytes itself, a `bytea` row per
megabyte or a file per upload under `aai dev`, and **`host/_upload-blobs.ts`
carries the four costs that got them out of Postgres** — storage price, WAL and
backup amplification, the app's own queries sharing their pool, and the
platform's forward reading a slow drain as a dead guest.

**The pairing follows the WORLD, off the same `DATABASE_URL`: an upload must
be at least as durable as the runs that read it.** With a database the record
goes in it and the bytes need a bucket — no bucket is the ONE refusal left,
since those runs outlive this container and a directory here cannot serve one
resuming elsewhere. With none the world is LOCAL, so both go in its data
directory (`host/_upload-files.ts`): per-process in a guest, the project's
`.workflow-data` under `aai dev`, where a restart re-enqueues the runs it finds
and finds their uploads. Same shape as the deleted file backend, opposite of
its bug — which was pairing a directory with runs in POSTGRES — and it is what
gives a databaseless studio agent uploads at all. `installWorkflowSupport`
ANNOUNCES the local home once: a tradeoff absent from the log reads as a bug.

**Neither direction takes turns with the socket.** A whole-file write puts
`UPLOAD_WINDOW_CONCURRENCY` windows while the next one is still arriving, and the
byte route reads `UPLOAD_READ_AHEAD` chunks ahead of what it has written — both
`mapStream` (below), which is where the ordering, the memory bound, and the
whole-window buffering that keeps a failed write re-sendable are argued.

## An upload can be read while it is still arriving

`POST /workflows/uploads` answers with an id once the last byte is stored — the
store writes an upload's record LAST, so "incomplete" and "no such upload" are
one answer and a run needing that id waits for the whole file. `PUT
/workflows/uploads/:id` is the other shape: the CALLER names the upload, so the
id is valid before the bytes are sent, the record exists from the first byte
with `complete: false` and a growing `size`, and `readUpload` — which already
clamped its window to what is stored — is what a run reads it with.

**`complete` is the only field a body may exit on.** A `size` that stopped
growing is what a slow link and a dead client both look like.

`host/workflow-uploads.ts` carries what that relaxation costs and how it is paid
for; `sdk/step-uploads.ts` owns the reader's half and the polling shape; the
author-facing half (`useWorkflowStream`) is in `packages/aai-ui/CLAUDE.md`.

## An upload can also arrive over SEVERAL connections

Both writes above carry the whole file in ONE request, so an upload runs at one
connection's throughput — a fraction of the link over any distance. `POST
/workflows/uploads/:id/parts?total=` declares an upload and `PUT
…/parts?offset=` fills in a window of it, so a browser sends eight at once. **It
is the DEFAULT** — `api.upload(file)` and every form hook take it unless a caller
passes `parallel: false`.

**Two rules make it invisible downstream**, which is why no reader, no step and
no range route changed: a part starts on an `UPLOAD_CHUNK_BYTES` boundary, so its
offset — which IS its object's name — is on a grid nothing can scatter; and
**`size` is the CONTIGUOUS prefix, never the sum of what has arrived** — parts
land out of order, so a size that counted bytes would tell a reader it may
read a hole. `complete` becomes true when that prefix reaches the DECLARED
total, which is the only observable moment every byte is present.

**On the platform the bytes do not come to the agent at all.** A deployed guest
holds no bucket credential, so each window goes to a route the PLATFORM serves
and a bodyless `PUT …/parts?offset=…&stored=1` tells the agent which landed —
whose size the store asks the BUCKET for rather than taking from the caller,
which is what stops a claimed part becoming a readable hole. The CLAIM decides
which path a client takes (`directParts`), because `aai dev`, a self-hosted
server and an agent deployed before this all answer the same way — see
`host/_upload-blobs.ts` and `aai-server/upload-handler.ts`.

**And `info` publishes WHICH windows landed** (`UploadInfo.ranges`), for an
unfinished parts upload and nothing else — a whole-file write has no windows, and
a finished upload is covered end to end. `size` is still the only field a READER
may act on; `ranges` is for the UPLOADER, and it is what makes
`api.upload(file, { resume: true })` send the missing windows rather than the
file. An agent too old to report them answers like an empty upload, so a resume
against one re-sends everything rather than leaving a hole.

**The width is 8 and the part size 8 MiB, so 64 MiB is in flight**, because what
the platform's h2 hop meters is concurrent large BODIES.
**`UPLOAD_PART_CONCURRENCY`'s own doc owns the argument** — why not wider (one
reset aborts every sibling in flight, so width is a blast radius), where the
measured shoulder is, and the table it had to DELETE for reporting a cliff its own
harness had caused. Read it, and `scripts/upload-sweep.mjs`, before moving
either number: `pnpm bench:uploads --target <base>` is believable now and still
prints no browser number.

**And the whole upload RE-ENTERS itself when the agent goes away.** The
per-request budget (~4-11s) covers a failure that happens while the agent is UP;
it cannot cover a redeploy, an idle reclaim or a `aai dev` restart, where every
part in flight burns its budget inside the outage and a 90%-stored recording is
thrown away in full. So a round failing for a reason that LOOKS like an outage is
run again with `resume: true` — reading the ranges and sending only what is
missing, which is why a budget of about a minute is affordable.
**`sdk/_upload-resume.ts` owns it**, including the three failures it refuses to
re-enter (an abort — also how a person's PAUSE arrives — a refusal status, and a
record the agent acknowledged and never wrote).

The client path DECLINES rather than fails (an
uncuttable string body, a file that fits in one part, an agent answering 404 to
the declaration), which is what makes it safe as a default rather than an opt-in
— and it is also the only upload path that can RETRY, since a single-request
`POST` retried after a lost response mints a SECOND upload and a `PUT` retried
against its own id is refused as taken. `sdk/workflow-upload-parts.ts` and
`host/_upload-store.ts` carry the rest, including the backoff, the `Retry-After`
it honours, and the two bracketing requests that are retried with it.

## Workflow apps and the workflow HTTP API

`AgentDef.page` declares an agent's front door — `"voice"` (the default, and
what absent means) or `"static"`, a page over the workflow HTTP API that
`createServer` mounts. **See "Workflow apps" in `packages/aai-ui/CLAUDE.md`**;
this guide is at its cap and the author-facing half lives there.

**Declare one with `workflowApp()`** — `sdk/define.ts`, the fourth arm of
`AgentParams`. Same `AgentDef`, refusing the fields a workflow app cannot use;
that guide's `workflowApp()` section owns the argument.

## The DevKit is never handed a BARE specifier

`host/workflow-resolve.ts` is the one helper, and the rule is one sentence: the
DevKit loads code from files whose LOCATION we do not choose, so a bare specifier
we pass it resolves against a directory with no `node_modules` above it and fails
naming a package that is plainly installed. Its own compiled artifacts land in
`tmpdir()`; so do the route modules `workflow-serve.ts` writes.

```text
Cannot find module '@workflow/world-postgres'
Require stack:
- /private/var/folders/…/T/index.js
```

Two call sites, one move, and the split between them is the MECHANISM the DevKit
will use — which is the part that has been got wrong:

- **`resolveWorldSpecifier`** for `WORKFLOW_TARGET_WORLD`, which the DevKit
  `require`s: an absolute PATH, resolved with `createRequire`.
- **`resolveImportSpecifier`** for the static specifiers `rewriteWorkflowImports`
  rewrites, which are ESM: a file URL, resolved with `import.meta.resolve`. Not
  interchangeable — `workflow`'s root entry maps `require` to its TypeScript
  PLUGIN, so the require form rewrote an ESM import to a CJS plugin that then
  failed loading `typescript/lib/tsserverlibrary`.

A specifier that will not resolve is left ALONE in both directions, so the load
fails with Node's own error naming the module rather than on an absolute path
that resolves to nothing.

**Writing those files somewhere with a usable `node_modules` above them is the
weaker fix** — it bets on a writable install directory, and it cannot work at all
for the DevKit's own artifacts, whose path is not ours to pick. (The guest does
anchor its WORKER bundle beside the harness, which is a different problem: that
file's requires are the tenant bundle's, and it falls back with a warning.)

**What no unit test here can check is the resolution itself.** Vitest patches
`createRequire`, so a bare specifier resolves from any directory in that tier —
verified: a negative control asserting the bare form fails from `tmpdir()` did
not throw. So the tests pin the SHAPE (absolute, and of the right kind), and both
assertions fail when the resolution is removed. Measured outside vitest, which is
where the property is real: the resolved path resolves from `tmpdir()` and the
bare specifier does not.

## A callback URL comes from `publicWebhookUrl`, never from `hook.url`

`createWebhook()` sets `hook.url`, and it is **guest-local**: the DevKit composes
it from `getWorkflowMetadata().url`, which is `http://localhost:<port>` off the
running process (its only other branch is `https://$VERCEL_URL`). Deployed, that
names the inside of a sandbox which has self-exited by the time a payment
provider calls back. So the SDK mints its own:
`ctx.workflows.publicWebhookUrl(token)` — `RuntimeOptions.publicUrl` plus the
same `WORKFLOW_WEBHOOK_PREFIX` the guest's own router parses, so the URL handed
out and the path that answers it cannot drift.

Three properties are load-bearing:

- **`publicUrl` is an OPTION, never sniffed.** Each deployment supplies it — the
  platform bakes `AAI_PUBLIC_BASE_URL` into the guest's exec env and the harness
  passes it through, `server.mjs` reads `PUBLIC_URL`, `aai dev` passes its own
  BACKEND origin (Vite proxies the browser surface and not the DevKit's
  `/.well-known/` routes, so the port a developer opens would 404 a delivery).
  Reading an `AAI_*` variable here would make the SDK depend on the vocabulary of
  one of its three deployments.
- **Unconfigured THROWS**, naming the option. A `localhost` URL would be the
  same bug with the failure moved days later and onto somebody else's server.
- **It takes the token, because a hook's token is the caller's.** Derive it in one
  exported helper the body and the tool both import — the rule {@link signal}
  already states. `createWebhook()`'s own token is random and body-side only,
  so a URL that has to be minted from a TOOL wants `createHook({ token })`.

Not yet closed: a `"use workflow"` BODY, and a step it hands `hook.token` to,
have no `ToolContext` and so no way to reach `publicUrl` — a run that must EMAIL
its own callback URL still composes it from a value the author supplies.
`stepEnv`'s `Symbol.for` slot is the shape that would close it.

## A run can tell the caller it finished

`start(def, input, { key, notify })` makes the session that started a run take an
UNPROMPTED, interruptible turn when it lands — the promise `research-workflow` used
to make ("I'll let you know") and had no way to keep. `Transport.injectTurn` is
the primitive (pipeline only; S2S has no such verb, so there it is a logged
no-op). **See `host/workflow-notify.ts`'s module doc** for the rest.

## Voices

**`ASSEMBLYAI_TTS_VOICES` in `sdk/providers/tts/assemblyai.ts` is the list.**
Read it there; do not restate it here, and do not trust a voice name that isn't
in it.

That instruction is the whole point of the constant. This section used to
carry
its own table, of which every entry was either deprecated or had never existed,
while the provider's doc comment carried a *different* wrong list — two
hand-maintained lists, both fiction, both pointed at by anyone looking for a
voice. The failure is invisible at authoring time: a wrong voice id is rejected
in-band after the TTS socket opens, so the agent connects, reports ready and is
permanently silent. Hence one checkable constant, with the accent alongside each
name and the deprecated set in `ASSEMBLYAI_TTS_DEPRECATED_VOICES`.

On the default pipeline the voice is the top-level `voice` field —
`agent({ voice: "michael" })`, an author convenience desugared to
`tts: assemblyAITts({ voice })` in `normalizeAgentConveniences` (typed against
the catalog, invalid alongside an explicit `tts` descriptor, which owns its own
voice). An explicit AssemblyAI TTS stage picks it with `assemblyAITts({ voice })`
from `@alexkroman1/aai/tts` (or `assemblyAIPipeline({ voice })`). S2S mode's
voice rides on the `s2s` descriptor — `voice` is a compile error there.

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

## Concurrency primitives (use these, don't hand-roll)

The repo's recurring async-coordination patterns are reified as small
primitives, and almost all of them live in this package — reach for one before
re-inventing the pattern at a call site. Two that do not are stated in the root
`AGENTS.md`: `p-timeout` for timeouts (never a hand-rolled `Promise.race` with a
timer) and native `AbortSignal.any([...])` for combining signals.

**Each primitive's module doc carries the hazard it reifies and the shape it
replaced; what follows is the index plus the rule and the adopters.**

- **`createEpoch()`** (`sdk/epoch.ts`, `@alexkroman1/aai/internal`) — staleness
  guard for async continuations: capture `current()` when deferring work, check
  `isCurrent(gen)` when it settles, `bump()` to invalidate. Adopted by the
  aai-ui connection/turn generations and the pipeline turn gate. Don't hand-roll
  `let generation = 0; generation++` counters.
- **`createOwnedMap()`** (`sdk/owned-map.ts`, `/internal`) — a map whose entries
  are removed by ownership TOKEN, so an async teardown settling after the key
  was re-claimed (reconnect resume, redeploy) can't evict the successor's entry.
  `owns()` guards non-delete mutations. Adopted by the runtime's
  `sessions`/`sinkMap`, the WS handler, and the platform `SlotCache`. Don't
  write `if (map.get(k) === mine) map.delete(k)` by hand
  (`guard-invariants` rule 8).
- **`createCoalescingRunner()`** (`sdk/coalescing-runner.ts`, `/internal`) —
  serialize + coalesce repeatable async work: at most one run in flight,
  triggers during a run share ONE trailing re-run started after the current
  settles, rejections never wedge the runner. For work that reads latest state
  when it runs (workspace sync, post-write typechecks). Don't hand-roll
  `inFlight`/`trailing` flag pumps.
- **`createTurnMachine()`** (`host/transports/pipeline-turn-state.ts`) — the
  pipeline transport's turn lifecycle (in-flight reply, spoke flag, TTS audio
  gate) as a discriminated-union machine whose named transitions are the only
  mutation path. New turn-state reads/writes go through it, not new closure
  flags.
- **`createKeyedLock()`** (`sdk/keyed-lock.ts`, `/utils` and the root — the one
  primitive here that is PUBLIC) — serialize async work per key; `withLock(lock,
  key, fn)` releases in every outcome, and an optional `timeoutMs` bounds the
  ACQUIRE, which is what makes a contended mutation answerable instead of queued
  (`KeyedLockTimeoutError` → the platform's 409). It is public because the
  hazard is an agent author's as much as the platform's: **the LLM loop runs a
  step's tool calls CONCURRENTLY**, so two async mutators of one external
  resource interleave at every await. Don't write
  `tails.get(k) ?? Promise.resolve()` by hand (rule 9) — the two parts that get
  missed are dropping the drained entry BY OWNERSHIP, and resolving your own
  place in the chain when you abandon a timed-out acquire.

  **For a session-state mutation reach for `slot.update` instead** (below): its
  window is synchronous, so it has nothing to serialize. This primitive remains
  the right answer for serialized work that is NOT a slot mutation — an external
  resource, a key that is not the session id, or `{ timeoutMs }` when a
  contended mutation must fail rather than queue. No template demonstrates it
  any more, which is recorded in `template-api-allowlist.json` rather than being
  an oversight.
- **`mapConcurrent(items, size, run)`** (`sdk/map-concurrent.ts`, `/utils` — the
  other PUBLIC one) — bounded fan-out inside a durable workflow body: a WINDOW
  over a cursor, so a slow item costs only itself. It was `mapInBatches`
  (sequential `Promise.all` batches, kept as a deprecated alias) on the belief
  that a pool broke replay, and it does not: the DevKit needs the SEQUENCE OF
  ITEMS whose calls are issued to be a pure function of the list, and a cursor
  that only ever hands out the next index satisfies that at any width and under
  any settle order. What the barrier cost was its slowest member once per round,
  which `transcription-workflow` measured at 6.7x p50 on a wide fan-out. **The
  rule that IS load-bearing** — `run` must issue the same sequence of step calls
  for every item, in practice one, synchronously — is unchanged by the shape and
  was never rescued by batching either; the module doc carries both halves.
- **`mapStream(source, width, run)`** (`sdk/_map-stream.ts`, internal) — the same
  bound over an ITERATOR rather than a list, for a body that does not exist yet
  and is expensive to pull: the next item is read only as a slot frees, so the
  window is the memory bound and the source's own backpressure is preserved.
  Results are yielded in SOURCE order, which the upload byte route cannot do
  without — it is writing them to a socket. Every task is wrapped so it SETTLES
  rather than rejects: a sibling's rejection sitting behind a slow head is an
  unhandled rejection and, by default, a dead process. The same wrapper is what
  lets a consumer leave early without stranding one. Adopted by the upload store's
  whole-file write and by `GET /workflows/uploads/:id`. Reach for `mapConcurrent`
  when the items are already in hand.
- **`sleep(ms, { signal?, unref? })`** (`sdk/sleep.ts`, `/internal`) — the ONE
  wait; `guard-invariants` rule 19 keeps the seventh spelling out. It replaced
  **six** spellings across five packages at 22 call sites, and the argument is
  not the line count: they split into two families differing in whether
  `vi.useFakeTimers()` can drive them, which no call site shows. **Read the
  module doc** for that measurement, why `unref` is opt-in (it is a claim, and
  the shared default it replaced made a shutdown grace skip its own drains), and
  why an abort resolves with the listener detached. Not a timeout (`p-timeout`,
  rule 3), not a yield (`flush()`/`tick()`, rule 4).

  **Never write a control character as a source literal.** A raw NUL in
  `host/workflow-notify.ts` made `git grep` call the file BINARY, so it was
  silently exempt from every repo gate — all of which are `git grep` — and had
  grown the sixth `sleep` where nothing could see it. Use `\u0000`.
- **`ToolFailure` / `isToolFailure()` / `toolFailure(message)`**
  (`sdk/utils.ts`, root and `/utils`) — the `{ error: string }` object a tool
  returns for a failure the MODEL should see and recover from, its guard, and
  its constructor. The guard is the point: failures propagate, so a helper
  returning `Order | ToolFailure` has a caller that forwards it unchanged, and
  `"error" in value` only works once the value is known to be an object. Five
  templates returned the shape; `retail` had its own `ErrorResult` + `isError`
  (used at ~40 sites) and `dispatch-center` narrowed with inline `"error" in
  inc` at six. The constructor exists so that "how do I report a failure?" lands
  next to `isToolFailure` rather than on `serializeToolFailure()`, which returns
  the pre-serialized wire STRING the host emits for a tool that THREW — so
  `isToolFailure(serializeToolFailure(m))` is `false`. Under its old name
  (`toolError`) that was a trap rather than a distinction, and it was used by
  ZERO of the fourteen templates despite its own doc telling authors to return
  it. It is `@internal` on `/utils` now; `utils.test.ts` pins both halves.
- **`pushCapped(list, item, max)`** (`sdk/utils.ts`, root and `/utils`) — append
  to a list holding a cap, mutating IN PLACE (the list is usually a property of
  a slot's value, so returning a new array is a reassignment the caller can
  forget). For the append-only lists an agent keeps: a timeline, an activity
  feed, a session log. Every one of them feeds an LLM summary or a `syncState`
  payload, so uncapped it grows what the model reads and what crosses the wire
  for the length of the call. Three templates had hand-rolled `push` +
  `slice(-MAX)`; the fourth, `infocom-adventure`, had NOT — its command history
  sliced only for display and grew without bound, which is the bug a shared
  primitive turns into a decision.
- **`omitUndefined()`** (`sdk/omit-undefined.ts`, `/utils`) — the one way to
  build the optional half of an object under `exactOptionalPropertyTypes`. That
  flag makes `{ name: maybeName }` an error whenever the value can be
  `undefined`, so the only spelling that compiles was
  `...(name !== undefined ? { name } : {})` — correct, and hand-written 44 times
  across five packages, eight of them in a single object literal in
  `host/agent-server.ts`. Each line names its key twice, which is what makes a
  mismatched pair (`x !== undefined ? { y: x }`) read as noise rather than as
  the bug it is. Write `...omitUndefined({ name, greeting })`; renaming a key
  works the same. `guard-invariants` rule 2 sees all three spellings, and its
  remedy names the three sites that deliberately keep the long form — the ones
  where the GUARD IS NOT THE VALUE. Check that before converting a fourth. It
  lives on `/utils` rather than `/internal` for the zero-zod reason
  `sdk/utils.ts`'s own module doc states.
- **`sessionSlot()`** (`sdk/session-slot.ts`, the ROOT — it is authoring API,
  not infrastructure) — a typed named slot that OWNS a session's state: its key,
  its default, its reads, its writes, its `syncState` projection, and its
  STORAGE. There is no `ctx.state` bag any more. See "A slot OWNS its session
  state" below.
- **`resolveOne(candidates, spoken, opts)`** (`sdk/spoken.ts`, ROOT only) — pick
  the one thing a caller named, or fail LISTING the candidates. See "Resolving
  what a caller SAID" below for the order it applies its readings in and why
  ambiguity is an ANSWER rather than a guess.

## A slot OWNS its session state — and stores it

There is no `ctx.state`. A session's state lives in `sessionSlot()`s
(`sdk/session-slot.ts`, root export), each of which owns its own key, its own
default, its reads, its writes, its projection to the client, and its STORAGE.
`AgentDef.state`, the state type parameter on `ToolContext`/`ToolDef`/`AgentDef`,
`InferAgentState`, `SlotState`/`SlotStateOf` and `getState` all went with the bag.

**The reason to remove it was that it could not be stored.** A slot's value used
to be a property of one mutable object in a `Map` in the runtime's heap, so it
died with the process: a crash, a redeploy, `handoverSlot`'s blue-green swap, or
the fleet-wide peer route a cold broker takes all handed a reconnecting caller an
agent that remembered the whole conversation (the client replays history) and had
forgotten its cart. Nothing on the client can replay state back.

Five rules follow, and each is enforced rather than documented. **`session-slot.ts`
carries each one on the member it governs** — read it before changing any of them:

- **`update` is SYNCHRONOUS and hands the body a mutable DRAFT.** Whatever the
  mutator leaves behind is stored when it returns, so a read-modify-write is
  atomic with no lock — which matters because the LLM loop runs a step's tool
  calls CONCURRENTLY. An await goes in FRONT of the mutation; `slot.updateTool`
  refuses a thenable body naming the rule, and a nested `update`/`set`/`reset` on
  the same slot throws rather than being overwritten by the outer draft (which is
  a write that succeeds and then vanishes — `pizza-ordering` had one). A throwing
  mutator stores NOTHING and does not wedge the slot for the rest of the session.
- **`slot.get()` returns a frozen `DeepReadonly<T>` — the TYPE matches the
  freeze.** Mutating what it returns is a compile error at every depth
  (`cart.items.push(x)` as much as `cart.total = 0`) and a `TypeError` for a
  caller with no types, because a mutation applied there is applied to a value
  nothing is going to store. A shallow `Readonly<T>` over a deep freeze left the
  RUNTIME STRICTER THAN THE TYPE and shipped in two templates. It propagates into
  an agent's own helpers, which is the price — one that will not take
  `DeepReadonly<T>` is one that mutates.
- **`slot.set()` stores a COPY** (`privateCopy`, a `structuredClone` for a durable
  slot), so the freeze lands on the slot's own object and never on the caller's.
  Its own examples — a load, an import, a restore — are exactly the cases where
  the caller still holds a reference to what it passed, and freezing in place
  turned an unrelated later line (`imported.items.push(...)`) into a `TypeError`
  from a stack naming nothing about this slot. `update` was always safe; its draft
  is the same copy. A VIRTUAL slot is handed the live value and nothing
  freezes it.
- **A durable value is checked STRUCTURALLY, in both backends.** `Map` → `{}`,
  `Date` → string, `NaN` → null: the values that corrupt do not throw, so
  `JSON.stringify` is not the check. Running it in the memory backend too is the
  whole reason that backend is a valid test double for the Postgres one — and why
  `createToolContext` carries a real slot store rather than a stub.
- **`syncState` takes `slot.projection(view)`**, which is CALLABLE and carries the
  slot's key and default. That is what lets the runtime render a session that has
  run no tool, and so what let `AgentDef.state` be deleted rather than remembered
  — four of five slot-backed templates used to forget to declare it.

**Which backend an agent gets is a property of the DEPLOYMENT**, never of a slot:
Postgres when `DATABASE_URL` is present, memory otherwise, reported in the
"Session mode resolved" line so the tier is answerable from outside. A per-slot
`persist` flag is refused for the reason above. A value that genuinely cannot be
stored declares `{ durable: false }` — a VIRTUAL slot, neither checked, frozen nor
committed.

**`SessionStateBackend.countEvents` is `max(event_index) + 1`, not a
`count(*)`.** It is read on hydrate so a session resuming onto a REPLACEMENT
process continues its event log rather than restarting at 0 and overwriting its
own history — and this log need not be dense from zero: an event past
`MAX_SESSION_EVENTS` advances the position without being stored, and a partly
failed flush leaves a hole. Under a count either case hands a resumed session an
index it has already used, so its `tail` goes BACKWARDS and the re-used appends
are silently dropped by `on conflict do nothing`. **Both backends must answer
`max + 1`**, or the memory one stops being a valid double for the Postgres one.

**Read `host/session-state-store.ts`** for the commit point (the end of the tool
call, awaited, once per changed slot), the fail-open rule for shape drift on
redeploy, and the size cap; `host/runtime-session-state.ts` for where a session
hydrates and where it is reclaimed; `host/session-state-postgres.ts` for the table
and what the app database guarantees. **Persistence is reliable across crashes and
best-effort across redeploys.**

**The tables come WITH the database, and this backend creates none.**
`sessionStateDdl` is the shape; the platform applies it when it provisions an
app's database (`aai-server/app-database.ts`), because the tables are part of
what "this app has a database" means, exactly as its role and grants are. The
backend used to `create table if not exists` on its own read and write paths,
behind two memos — and the argument for that (the shape belongs to the BUNDLE's
SDK version) does not survive inspection: `if not exists` is a no-op once the
table exists, so a newer SDK expecting an added column was broken either way.
What it cost was two round trips and a `42P07` NOTICE per guest boot, in the log
an operator reads to diagnose a session. A missing table now surfaces as the
honest error it is — this app's schema was never provisioned with one.

**A slot is also the only thing carrying a state TYPE into a tool, because a tool
is a FILE.** `agent()` takes no `tools` argument — `tools/incident_create.ts` that
default-exports `tool({ … })` IS the tool `incident_create`, and the table is
filled by `withTools` over a registry the build enumerates. What that removed
along with the map is the map's one type-level service, checking each tool's
assignability against the agent's state shape; `slot.tool()` (reads) and
`slot.updateTool()` (writes) are what a stateful tool module reaches for instead.
And **`agent()` THROWS on a `tools` key** rather than only rejecting it in the
type: neither bundler type-checks user code, so the type alone would make "a tool
is only ever a file" true of this repo and of no user's project
(`assertNoInlineTools` in `sdk/define.ts`). `withTools` stays the seam a non-file
registry attaches through, which the studio's own coding agent needs — its tools
close over one session's workspace directory.

## Resolving what a caller SAID (`sdk/spoken.ts`)

A voice agent's tool arguments do not arrive as ids: "cancel my second order",
"the blue medium one", "eight six four two, one nine…". `resolveOne(candidates,
spoken, { describe, label?, score? })` on the root barrel picks one, and the
interesting part is what it does when the utterance picks NONE or MORE THAN ONE
— a {@link ToolFailure} that LISTS the candidates, which is the one shape that
lets the model recover on its own turn instead of acting and apologizing.
`spokenDigits` and `spokenOrdinal` are the two readings it consults, exported
because an agent narrowing by its own vocabulary needs them before the pick.

Three things the API is load-bearing about:

- **The ORDER is the contract**, and it is why this is a function rather than a
  pattern: no candidates → say so; a POSITION ("the second one", "the last one")
  → take it, since a caller who counts is unambiguous even when nothing else is;
  the scorer, whose tie FAILS rather than resolving; exactly one left → it;
  anything else → ambiguous. The caller narrows first, by whatever its domain
  understands.
- **`spokenOrdinal` matches on word boundaries and cannot do better.** "firstly"
  and "the 21st" are correctly not positions; "the first aid kit" IS one, because
  it really does contain the word "first". That is the reason positions are
  consulted after the caller's own narrowing rather than before, and
  `spoken.test.ts` pins the limitation as a test rather than leaving it to be
  rediscovered.
- **It is on the ROOT and not `/utils`**, which every other tool-body helper
  reaches through. `spoken.ts` imports `toolFailure` from `sdk/utils.ts` — the
  `/utils` subpath module itself — so re-exporting it there would be a cycle.
  The root is where an agent author works anyway.

`retail`'s `resolve.ts` is the worked example, and the split there is the one to
copy: the SDK owns never-guess, the template owns what an order id looks like
when a caller reads it aloud and which words name a status.

## Storage (`ctx.db`)

There is no KV store anymore. Persistent state is the opt-in **app database**:
enabling storage for an app (CLI `aai storage enable <slug>`; the studio's
Settings pane → Database, which switches BOTH of a project's agents at once —
see the Database-card note in `packages/aai-studio-client/CLAUDE.md`; or
`DATABASE_URL` in the project `.env` under `aai dev`) gives its tools `ctx.db` —
a SQL handle (`query<T>(sql, params?)`, `$1` placeholders) backed by the app's own
DATABASE in the platform's Supabase instance. Accessing `ctx.db` without storage
enabled throws with that enablement guidance. On the platform each app gets its
own DATABASE + login role (its tables in `public`, no `search_path` pin needed,
10s statement_timeout, `CONNECT` revoked from `PUBLIC`); credentials live in
Supabase Vault. A schema per app could not host a durable workflow at all — the
Workflow DevKit's `workflow` and `graphile_worker` are database-level names — so
`aai-server/app-database.ts` is the argument.

**`ctx.db` connects DIRECTLY from the guest** — the app's own scoped Postgres
credentials ride in as `DATABASE_URL` in the agent's boot env and the bundle's
runtime opens its own connection, exactly as `aai dev` does with a project
`.env`. The old host-proxied `db/query` RPC is gone: it kept a versioned RPC in
the harness↔bundle contract to protect a credential that only reaches the
tenant's own data anyway.

Session-scoped scratch belongs in a `sessionSlot` (or the `remember`/`recall`
builtins, now in-memory per-session) — which is durable through the same app
database when one exists, so the two differ in SHAPE (a typed value per session
vs. SQL an author writes) rather than in whether they survive. There is no
Vector store anymore either — `ctx.vector`, the `vector:` agent field, the
`@alexkroman1/aai/vector` subpath and the platform-owned `PINECONE_API_KEY` were
all removed; if retrieval returns it follows `ctx.db`'s path.

## Guest network access

There is **no per-agent egress policy**, and the network builtins screen a URL
only when there is no container around them (`builtinFetch` in `host/ssrf.ts`).
`host/ssrf.ts` is the implementation and lives here so the platform's guest-fetch
proxy and the SDK's own builtins resolve ONE copy of it. **The policy, the
`AAI_SANDBOX_CONTAINED` declaration, the screen's bypass classes and the two
undici-version traps in the pinned dispatcher are in
`packages/aai-guest/CLAUDE.md`, "Guest network access"** — the guest is what the
rule is about, and this guide is at its cap.

## A request-path decode never throws

**`decodePathSegment` (`host/_path-decode.ts`) is the one spelling**, applied at
all five decode sites (`workflow-api.ts` x2, `server-static.ts`,
`workflow-serve.ts`, `session-events-api.ts`). `decodeURIComponent` THROWS a
`URIError` on a malformed escape and a request target is attacker-supplied:
`GET /.well-known/workflow/v1/webhook/%` is a legal HTTP request that nothing in
the stack rejects before a handler cuts the path apart. Those five sites sat in
three different accidental safety regimes — one caught explicitly, three inside
an `async` router whose rejection is answered 500, and **one fully synchronous**
(`webhookToken` → `pickWorkflowHandler` → `handleWorkflowRequest`, called from
`createServer`'s `options.request?.(…)` hook with no `try`). That one reached the
guest's `uncaughtException` guard and `process.exit(4)`, unauthenticated, taking
every concurrent voice session on the sandbox down with it.

So the decode is a FUNCTION with a stated contract rather than an expression
repeated with different luck: `undefined` means "this is not a decodable path
segment", and each caller answers it the way its own route answers a bad request
— a 400, a 404, or a decline. **There is no spelling of this that throws, and a
caller must never re-throw it**; the module doc carries the rest.

## A builtin's HTTP read is bounded at the READ, in BYTES

**`fetchCappedText` (`host/_fetch-capped.ts`) is the one bounded fetch** for
every builtin that reads a model-controlled URL — `visit_webpage`, `fetch_json`,
`get_page_design`'s page and stylesheet reads, and `web_search`'s two endpoints.
Two rules it exists to make unrepresentable:

- **The cap bounds the READ, not the value that is kept.** Every site used to do
  `const body = await resp.text()` and only then slice or refuse it, so the body
  was fully buffered into host memory first and the "cap" bounded nothing — the
  real limit was `FETCH_TIMEOUT_MS` times the link's bandwidth, on a URL a prompt
  injection picks. (`fetch_json` additionally pre-checked `content-length`, which
  reads `Number(null)` → `0` for any chunked response and therefore passed the
  guard exactly when the body was unbounded.) The body is read through
  `resp.body.getReader()` one chunk at a time, stopping the moment the budget is
  exceeded and cancelling the stream.
- **The budget is in BYTES, never `String.length`.** The old caps compared UTF-16
  code units against a byte budget, so a body of multi-byte characters passed at
  up to ~3x its nominal size.

`truncated` is the caller's decision: a page is worth reading in part, where a
JSON document clipped mid-value is not parseable and must be refused. An HTTP
failure is answered as `{ ok: false }` rather than thrown, because every caller
turns one into a tool result.

## The session takes two VOCABULARIES, not nineteen callbacks

`SessionCore` takes a `command(cmd)` — one `SessionCommand`, what the CLIENT asks
for — and a `report(event)` — one `TransportEventBody`, what the TRANSPORT
observed. `TransportCallbacks` is the same `report` from the other side. That is
the whole inbound surface, plus the two audio paths. It used to be one method per
thing, the same names declared on both sides with a forwarding table between them
and a stub in every harness: **157 `on*` declarations across eleven files, 78 of
them test scaffolding**, none of which decided anything.

Three rules, and `guard-invariants` rule 16 checks the first per file:

- **A callback survives exactly when there is NO EVENT for it** — binary audio,
  `onReplyStarted` (the wire has no `reply.started`, and minting one is a protocol
  change), `onSessionReady`, and the socket-lifecycle hooks a caller must ACT on.
- **Report `agent-transcript.committed` or `.updated`, never a boolean.** Those
  two names carry exactly what `onAgentTranscript(text, interrupted)` plus a
  separate partial callback used to; only the committed one enters history.
- **`reply.completed` is the PROVIDER's claim, not the turn's end** — the one
  report whose name and emitted event can come apart. See `session-reply-done.ts`.

**Audio is not joining the hook surface, and not for cost reasons.** A handler
runs synchronously off `emit` and an async one is never awaited
(`session-emitter.ts`), so no subscriber can add latency to a turn. What keeps
audio out is MEMBERSHIP: `playback_progress` is a client→server command and audio
frames are binary, so neither is in the event vocabulary and neither can be a hook.

**Read `host/transports/types.ts`** for the boundary and the full argument;
`host/session-core.ts` and `host/session-commands.ts` own the two dispatchers.

## A `reset` starts a conversation, so it GREETS

The client `reset` frame — aai-ui's "New Conversation" button — discards the
conversation, and a conversation that begins without the agent's declared
opening line is not the one the agent declares. The pipeline transport greeted
only from `onAudioReady`, once per CALL, so every conversation after the first
opened on silence: the caller cleared the transcript and then sat listening to
a live mic with nothing to prompt them. `reset()` therefore ends by calling
`lifecycle.greet()` — queued AFTER `gate.invalidateAll()` so the strand that
kills the pre-reset turns cannot catch it, and on the turn chain so it runs
after the aborted turn unwinds rather than interleaving with it.

**`skipGreeting` deliberately does not reach `greet()`.** It is a RESUME flag
scoped to a connection's start ("this caller already heard the opening line"),
which is the opposite claim from a reset. That is also why aai-ui's `reset()`
drops the resume identity when the socket is already closed: there the redial
IS the new conversation, and a `?sessionId=`/`resume=1` reconnect would rejoin
the old one — server history kept, greeting suppressed.

**Neither S2S transport re-greets, and that is a known gap rather than a
decision.** AssemblyAI S2S has no `reset()` at all (its greeting is dispatched
service-side from the session config, with no protocol verb to replay it), and
OpenAI Realtime has none either — its `sendGreeting()` is a one-shot
`response.create` that could be re-issued, but the service still holds the
conversation a reset is supposed to discard, so re-greeting alone would open a
"new" conversation the model can still see the whole of. Clearing it means
tracking every `conversation.item` id to delete, which is its own change.

## History records what was HEARD, not what was generated

An interrupted reply lands in history as the words the caller is estimated to
have actually heard, marked `[interrupted]` — not everything the model produced.
A reply cut before anything was audible records **nothing at all** (its
completed tool steps still do). That is LiveKit's rule, and it exists because
TTS runs behind the text: a barge-in discards whatever is still in the
provider's buffer, so the old record told the model it had delivered
information the caller never got, and the model then never repeated it.

**One cursor, one owner** — `host/transports/pipeline-heard.ts`
(`createHeardTracker`). It answers exactly one question: given this reply's TTS
text and its forwarded audio, which characters did the caller hear? History
truncation and the false-interruption resume anchor (`buildTailResumePrompt`)
are two READERS of that one answer, which is what keeps the resume prompt from
quoting words the record denies. It also owns the playback clock, so the
barge-in gate reads the same object.

Two tiers of accuracy, decided at RUNTIME rather than by a capability flag: a
provider that reports word timings (AssemblyAI TTS's `WordBoundaries` frames,
parsed in `providers/tts/assemblyai-words.ts`) gives a cursor at the last word
whose audio WHOLLY elapsed; Cartesia and Rime both HAVE a timing frame that is
not wired up, so they degrade to a proportional estimate snapped to a word —
exactly what was there before, so nothing regresses, and the zero case needs no
timings at all. Both roundings err toward UNDER-keeping, deliberately:
over-keeping is the measured failure, while under-keeping costs a word or two of
redundancy that the resume prompt's "without repeating what they already heard"
absorbs.

**The proportional estimate is CLAMPED, because `spoken.length / audioMs` is
not a speech rate** (`MAX_SPEECH_CHARS_PER_MS` in `pipeline-heard.ts`). Text
runs ahead of synthesis by however far the LLM is ahead of the voice — widest
mid-reply, which is exactly when a barge-in happens — so the raw ratio reads
text nobody has spoken yet as heard: an LLM streaming ~200 chars/s against a
provider synthesizing at 1x hands over a 300-character reply inside 1.5s, so
five seconds in the ratio claims all 300 characters against the ~75 the caller
actually heard. No causal bound fixes that, because the gap is PROPORTIONAL
rather than additive. The rate has to come from the language instead: English
narration runs 14-18 characters a second, so the ceiling sits at the top of that
band and the estimate takes the MIN of it and the observed ratio — a voice
slower than the ceiling is still tracked. The constant's doc carries the
arithmetic.

**The lag is `HEARD_AUDIO_LAG_MS` (750), and it is DERIVED rather than
measured** — its row in the defaults table below carries the decomposition and
why it is a second constant; do not restate it here.

**The client's committed transcript and the history entry now diverge on
purpose.** The caption still shows everything that reached TTS, because it was
published as interims while the audio was being synthesized. It CANNOT be
corrected after the fact to match the shorter record: emitting an
`agent_transcript` after `cancelled` is the measured 19-of-73 double-transcript
bug (`persistInterruptedTurn` in `pipeline-history.ts` — read it there).

Two mechanisms this leans on: the audio gate (a cancelled turn's late audio AND
its late word timings are both dropped by it, so no second epoch was invented),
and `emitText`'s `record` flag, which now decides what may be truncated into
history as well as what reaches `onDelta` — filler is audible, so it moves the
heard POSITION, and is never recordable. The TTS coalescer flushes when that
flag flips so no batched send ever mixes the two.

**Not covered: a barge-in during the TTS drain.** `runTurn` has already
committed the full text by then, so that case keeps `buildTailResumePrompt` as
its only mitigation (which this change makes word-truthful). Fixing it means
deferring the history commit until after the drain — a change to `runReply`'s
body contract, deliberately separate.

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
`cancelled` handler at all, so the one event that really means "the agent
stopped" is ignored and the one that did not is treated as authoritative — a
reply still being spoken was thrown away mid-sentence. (`aai-ui` reads the event
as informational and stops playback on `cancelled`, which is why this never
showed up in the browser.) Measured by replaying the benchmark's own recorded
caller audio against a live pipeline agent, on the run's 10 conversations
richest in these signals: **184 `speech_started` against 87 `cancelled` — 53% of
the events the client acted on were not interruptions at all.** The agent
yielded to non-directed speech on 12 of 12 occasions and then sat silent a
median 5.9s (real barge-outs, not inter-sentence gaps: only 2.5% of natural gaps
between agent segments are ≤0.6s).

So while the agent holds the floor the edge is HELD, and released only when a
barge-in really fires (alongside `cancelled`) or when the agent stops speaking
on its own; while the agent is silent it passes straight through, because there
is no floor to yield. Live captions are unaffected either way —
`user-transcript.updated` is emitted independently of the gate.
**`pipeline-speech-edges.ts` owns the mechanism**, and its two layers are
deliberately separate: `createSpeechEdgeTracker` decides WHEN an utterance
starts and ends (pipeline mode has no VAD, so this is derived from partials and
finals, with a watchdog for utterances that never commit), and
`createGatedSpeechEdges` decides WHETHER the client is told. The turn
orchestration consuming both is `pipeline-user-speech.ts`.

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
`GET /:slug/client-config` broker) — "server" below means the process running
the runtime: the guest harness on the platform, the `aai dev` server locally.
The audio path depends on the session mode:

- **S2S mode**: browser captures PCM → WebSocket → server relays it into a
  single AssemblyAI S2S socket → the agentic loop (LLM + tools) runs
  service-side → synthesized audio streams back through the same socket →
  server forwards it to the browser. An interrupt cancels the in-flight turn.
- **Pipeline mode**: browser captures PCM → WebSocket → server forwards it to
  the STT provider → partials stream to the client as
  `user-transcript.updated` (live captions) and drive the
  `speech.started`/`speech.stopped` edges → the committed turn is reported as
  `user-transcript.committed` → the host runs the LLM loop via `streamText`
  (tool calls execute host-side just as in S2S mode) → assistant text chunks
  stream into the TTS provider → audio returns over the client WebSocket. An
  interrupt cancels the in-flight LLM stream and TTS playback; a barge-in that
  never commits a user turn is a false interruption and the reply resumes (see
  `resumeFalseInterruption`). `preemptiveGeneration` (OFF by default, measured)
  opens a branch one step earlier — see its row below.

## Default values and magic numbers

All numeric constants live in `packages/aai/sdk/constants.ts` (client-audio
budgets are split into `sdk/client-audio-constants.ts` for file-length reasons
and re-exported from `constants.ts`, so the import path is unchanged). Key
defaults that affect agent behavior:

| Default | Value | Where applied | Notes |
| --- | --- | --- | --- |
| `maxSteps` | 10 (`DEFAULT_MAX_STEPS`) | `constants.ts` | Max **tool-calling** steps per reply, LiveKit's `max_tool_steps` analog. **The cap and the forced final answer are ONE change and must not be separated, whatever the number is.** `stopWhen: stepCountIs(n)` alone ends the turn wherever the budget runs out — including straight after a tool result with nothing said — and that reply completes *successfully* with an empty transcript, so `errorPhrase` never fires and the caller simply hears the agent stop. So the `stopWhen` budget is `maxSteps + 1` and `prepareStep` forces `toolChoice: "none"` on that extra step (`forceFinalAnswer`, `pipeline-llm-stream.ts`); the override also beats an agent-level `toolChoice: "required"`, which would otherwise demand a tool call on the one step where tools are off. **`DEFAULT_MAX_STEPS`'s own doc (`sdk/tool-loop-constants.ts`) carries the measurement** — the 815-reply tau2-bench distribution, the cap of 3 that was tried and reverted, and why the single 10-step reply is a DEAD-AIR finding (tune the silence, not the cap) rather than a step-limit one. Note S2S enforces the same cap service-side by refusing tool calls past it (`session-core.ts`), where no forced final step is possible. |
| `toolChoice` | `"auto"` | runtime resolution | LLM decides when to use tools vs respond directly. Full AI SDK set: `"auto"`, `"required"`, `"none"`, `{ type: "tool", toolName }`. |
| `idleTimeoutMs` | 300,000 (5 min) | `constants.ts` | `0` or non-finite disables the timer entirely. Re-armed on every inbound audio frame (`resetIdle`), so it measures silence, not call length. On expiry session-core emits `idle_timeout` **and closes the socket** — the event alone retires nothing. |
| `silenceTimeoutMs` | unset (disabled) | `pipeline-silence.ts` | Pipeline only: assistant proactively takes a turn after this much user silence. Capped at `MAX_CONSECUTIVE_SILENCE_NUDGES` (3) back-to-back nudges until the user speaks again. `silencePrompt` customizes the injected instruction (default `DEFAULT_SILENCE_PROMPT`); it is kept in LLM history but never emitted as a user transcript. |
| `minBargeInWords` | 2 (`DEFAULT_MIN_BARGE_IN_WORDS`) | `constants.ts` | Pipeline only: interim-transcript words before user speech interrupts the in-flight reply. 2 keeps one-word backchannels from cutting the agent off; sub-threshold finals are answered after the reply. |
| `interruptionMinDurationMs` | 500 (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`) | `constants.ts` | Pipeline only: sustained speech (ms since the utterance's first partial) required before an interim-triggered barge-in fires — LiveKit's `min_interruption_duration` analog. Non-zero by default: room noise and echo of the agent's own voice produce short interim transcripts, and each one used to abandon a reply mid-word. Finals are never gated. 0 disables. |
| AssemblyAI `min_turn_silence` / `max_turn_silence` | 1600 / 3500 (`DEFAULT_MIN_TURN_SILENCE_MS`, `DEFAULT_MAX_TURN_SILENCE_MS`) | `host/providers/stt/assemblyai.ts` | **Two knobs, not one, and the pause-tolerance one is the MAX.** The minimum is when the model runs its end-of-turn CHECK (the turn ends only if it READS as complete), so it is the latency floor on every finished utterance; the maximum force-ends regardless of content and is paid only by utterances that never read complete. Both are always sent, because the service defaults them independently and sending only one is how they invert — the bug this pair replaced, where raising the minimum past the unset maximum's 1536 made every ending come from the acoustic fallback that splits utterances. **The evidence lives in `sdk/endpointing-constants.ts`'s module doc** — the 800 and 3000 reverts, the 600-2000 sweep that puts the knee at 1600, why a pause histogram is the wrong instrument, and the measured no-ops (`interruption_delay`, `mode`, ~470 ms to first partial being a model floor). Read it before changing either number rather than re-deriving it. Override via `assemblyAIStt({ minTurnSilenceMs, maxTurnSilenceMs })`. |
| AssemblyAI `voice_focus` / `voice_focus_threshold` | `near-field` / 0.9 (`DEFAULT_VOICE_FOCUS_THRESHOLD`) | `host/providers/stt/assemblyai.ts` | **Both are always sent together; the threshold is above the service's own 0.7.** The interferer this tunes for is background SPEECH, and the symptom reads as a hallucinating model and is not one. **`DEFAULT_VOICE_FOCUS_THRESHOLD`'s doc owns the evidence** — why no VAD setting substitutes (suppression before the model vs. a frame gate after it), the 15 dB SNR tau2-bench measurement behind 0.9, why `far-field` is much worse, and why disabling Voice Focus surfaces as a TURN-TAKING failure rather than a transcription one. What it does not carry is the **`vad_threshold` sweep run in the same harness, which loses in BOTH directions** — which is why that knob stays unset: 0.6 cut leakage to 15% but collapsed recall to 51% and took key facts *below* baseline (8/12), because the caller's quiet spelled letters are exactly what a stricter gate discards; 0.05-0.20 left recall flat at 70-71% (voice focus had already saturated it) while leakage rose 19% -> 27%, buying one recovered utterance — the content-free "Still waiting." — for five words of traffic report. Override via `assemblyAIStt({ voiceFocus, voiceFocusThreshold })`; the threshold is omitted entirely when voice focus is off. |
| Deepgram `endpointing` | 1500 (`DEFAULT_DEEPGRAM_ENDPOINTING_MS`) | `sdk/providers/stt/deepgram.ts` | Same role as `min_turn_silence` above — the provider owns end-of-turn; override via `deepgram({ endpointing })`. |
| `errorPhrase` | `"Sorry, I had a problem just then. Could you say that again?"` (`DEFAULT_ERROR_PHRASE`) | `pipeline-turn-outcome.ts` | Pipeline only: spoken when the turn's LLM stream fails, so a provider outage hands the conversation back instead of going silent. A failed turn produces no text, so nothing would otherwise reach TTS and the only trace is a `llm` session error the browser surfaces without a sound. `""` disables. |
| `deadAirCoverMs` (dead-air cover) | 5000 ms (`DEFAULT_DEAD_AIR_COVER_MS`) | `pipeline-stream-parts.ts` | Pipeline only, **ON by default**: a turn that sends nothing to TTS for this long gets a short filler, armed as the turn's stream opens and re-armed across every tool call so it covers the pre-first-token gap as well as the chain; `0` disables. **It used to be silently disabled in the shipped default** — the enable was `holdPhrase.length > 0` and `holdPhrase` had been defaulted to `""`, so one knob turned off two mechanisms and no spec noticed. **Why 5000 rather than 2000 or t=0 is argued on `DEFAULT_DEAD_AIR_COVER_MS`**, and **`DEAD_AIR_COVER_PHRASES` owns the rule that a phrase must be purely declarative**, with the call it derailed. The fillers are emitted `record: false`: they reach TTS and the INTERIM transcript so the caption matches the audio, and never `onDelta`, so they stay out of history, `ctx.messages`, resume and the STT agent-context hint. That flag has a SECOND consumer — the heard cursor (`pipeline-heard.ts`) carries it through to the TTS send so filler moves the heard position (it is audible) without ever being truncatable into the record. **The prompt no longer asks for a holding line either** — see `PROMPT_TOOLS`, which records the 15% -> 43% -> 29% measurement that retired it. |
| `resumeFalseInterruption` | `true` | `pipeline-transport-options.ts` | Pipeline only: a partial-triggered barge-in that never commits a user turn (STT noise) resumes the interrupted reply via a synthetic continuation turn. `false` disables. **It is a boolean because the WAIT cannot be an author knob** — it fires when the transcript stream goes quiet with no committed final (the speaking edge's idle watchdog, `DEFAULT_SPEECH_IDLE_TIMEOUT_MS`, 4000, internal), and the rule is stated on `PipelineVoiceTuning.resumeFalseInterruption`. Nothing shorter is safe: this was a `falseInterruptionTimeoutMs: number` defaulting to 2000, measured from roughly the same instant as the STT's `min_turn_silence`, so EVERY genuine barge-in raced its own resume and the resume won often enough to be the common case — each costing a billed LLM turn, putting "the user did not actually say anything" in history directly ahead of the real user turn, and making the caller hear the agent continue the reply they had just interrupted. The floor on the deadline is the STT's endpointing plus final-emission latency, which the transport cannot see, and the ceiling is patience, so there is no useful range to expose; the old number never governed anything anyway (a probe at `falseInterruptionTimeoutMs: 3` resumed at ~3500ms). A mid-turn cut resumes from the `[interrupted]` history marker only when no cut point is known; otherwise the prompt quotes the estimated last-heard words (`buildTailResumePrompt`) — measured, resuming from the marker instead repeated 60%+ of the words in 10% of consecutive agent utterances. That anchor is the SAME cursor history is truncated with (`pipeline-heard.ts`), so it can never name words the record denies. |
| `preemptiveGeneration` | `false` | `pipeline-speculation.ts` | Pipeline only, **OFF by default because it was finally measured.** Starts the reply from a high-confidence STT INTERIM (`SttTurnMeta.endOfTurnConfidence` >= `PREEMPTIVE_CONFIDENCE_THRESHOLD`, 0.9) and ADOPTS that running stream when the committed final says the same thing. **The whole measurement is on `PipelineTransportOptions.preemptiveGeneration` (`pipeline-transport-options.ts`) and restated for authors on `PipelineVoiceTuning` (`sdk/agent-voice-tuning.ts`)** — the 16/14/0.44s head start, the 36% poisoned after adoption, the +8ms net per caller turn for 44% of requests thrown away, the `hasText()` adoption gate that was tried and reverted the same day, and the second measurement (a tau2-bench run showing no reward regression) still owed before it goes back on. What lives only here: the two structural guardrails that made ON survivable — no speculative speech (`createStreamPartHandler` is the only path to `sendTtsText` and is built only inside `consumeLlmStream`) and no speculative tool execution (`toDeclaredTools` omits `execute`, so a speculation reaching a tool call is discarded WHOLE, preamble included) — the match rule `normalizeUtterance(final) === normalizeUtterance(partial)` (an extension, truncation or revision all discard), the sawtooth rules (a differing partial aborts at once, identical text at rising confidence never re-fires, at most `MAX_PREEMPTIVE_SPECULATIONS_PER_UTTERANCE` (2) per utterance), inertness unless `toolChoice` is `"auto"`/`"none"`, the double pin of the default (`pipeline-transport-options.test.ts` at the resolver, `pipeline-preemption.test.ts` end-to-end) so a flip either way is a deliberate edit, and that a speculation must never call `emitError` — it has no reply the client knows about. |
| `HEARD_AUDIO_LAG_MS` | 750 ms | `pipeline-heard.ts` | Pipeline only, internal (no agent field; the transport takes a `heardLagMs` for tests). How far behind the "audio forwarded" bookkeeping the caller's ear is — subtracted from the estimated playback position to get the cursor that decides what an interrupted reply records and where the resume anchor sits. **DERIVED, not measured**, and its own doc says why it is a SECOND constant rather than a reuse of `PIPELINE_PLAYBACK_GRACE_MS`. See "History records what was HEARD". |
| `maxHistory` | 200 | `constants.ts` | Sliding window of conversation messages retained. **The LLM view is trimmed by `capLlm`, not `cap`** (`pipeline-history.ts`): that view holds tool-call/result PAIRS, and an index trim can land between an assistant `tool-call` message and the `tool` message answering it. Both providers reject an unmatched tool result outright, so every remaining turn of the call failed at the provider and the caller heard `errorPhrase` instead of a reply. Turn sizes vary — 2 messages for a text-only turn, 4 for one tool call, more for a chain — so the window drifts out of alignment with turn boundaries on its own; nothing about the conversation has to be unusual. Only the FRONT is trimmed, so dropping leading `tool` messages is sufficient. A uniform turn size hides the whole class: 4 divides 200, so every trim lands on a turn boundary. |
| resume grace | 120,000 (`SESSION_RESUME_GRACE_MS`) | `constants.ts` | How long a disconnected session's slot state survives awaiting a `?sessionId=<id>` resume; the constant's doc carries the ~105s client-reconnect span it is sized against. It bounds the IN-PROCESS half only: a durable value outlives it and is reclaimed by the platform's TTL sweep (`aai-server/_session-state-sweep.ts`), because an agent guest that self-exits on idle can reclaim nothing. |
| `builtinTools` | `DEFAULT_BUILTIN_TOOLS` (empty) | `constants.ts` | NO built-ins are enabled by default — omitting the field and passing `[]` mean the same thing, and every built-in is opt-in by name. A custom or relayed tool with the same name wins. **The constant's doc carries the evidence that argues the OTHER way** (the reverted trim to `["calculate"]`, the tau2 measurement where the model invoked neither `think` nor `calculate`, the prompt-size cost) and should have to be answered by any change. This row read "`think`, `remember`, `recall`, `calculate` … on by default" long after the constant went empty; it is `as const satisfies` now so the emptiness is a type-level fact. |

## Provider sockets disable permessage-deflate

**Every provider-facing `ws` client must spread `PROVIDER_WS_OPTIONS`**
(`host/_ws.ts`) — `defaultCreateHeaderWebSocket` (S2S + OpenAI Realtime),
`providers/tts/rime.ts`, `providers/tts/assemblyai.ts`,
`providers/stt/soniox.ts`. That module's doc carries the measurement and the
`ws` client/server default asymmetry behind the rule; this guide is at its cap.
`host/_ws.test.ts` pins the wire behaviour against a server that offers the
extension, and the three adapter suites assert the constructor option.

The vendor-SDK providers (`assemblyai` STT, `@deepgram/sdk`,
`@elevenlabs/elevenlabs-js`, `@cartesia/cartesia-js`) keep their WebSocket
private and expose no option to pass through, so they are NOT covered — their
compression behaviour is whatever the SDK and the provider negotiate. Worth
re-checking if one of them shows unexplained per-session memory.

## Self-hosted server defaults (`aai/host/server.ts`)

`createServer` has no request authentication of its own — it is the `aai dev`
backend, not the managed platform — so two defaults are fail-closed: it **binds
loopback** (`127.0.0.1`; pass `"0.0.0.0"` deliberately, and `aai dev` exposes
`AAI_DEV_HOST` for setups where loopback isn't reachable), and **host mode is
opt-in** behind an explicit `AAI_ALLOW_HOST`. `createHostServer`
(`host/host-server.ts`) is the host-only server in one call; its module doc
carries the three ways the hand-rolled version was wrong.

**The rest — why a host client may bring its own provider credentials and what
makes that safe to expose self-serve, the `ALL_PROVIDER_ENV_VARS` allowlist and
why the gate is checked against the SERVER's env before the merge, the
`buildHostAgent` correction (a host session with no base agent runs the DEFAULT
PIPELINE, not S2S), and the host-mode audio pacing measurement — is in
`packages/aai-cli/CLAUDE.md`, "Running the SDK's own server (`aai dev` and host
mode)".** It went there when this guide hit its size cap; `aai dev` is the
server's principal caller and the CLI owns `AAI_DEV_HOST`, `hostModeEnv` and
`resolveServerEnv`.

## Telephony: a phone call is an ordinary session

`WS /phone` (`host/telephony/`) accepts a carrier's bidirectional media stream —
Twilio Media Streams, Telnyx media streaming — and runs it as an ordinary
session. `createServer` serves it by default, so `aai dev`, a self-hosted server
and every deployed agent all answer phone calls with no per-agent configuration.
**Nothing in the session stack knows about telephony, and that is the whole
design**: the adapter is a socket-shaped SHIM (`createTelephonyBridge`) speaking
the client protocol on one side and the carrier's JSON framing on the other,
handed straight to `runtime.startSession`. Resist adding a telephony branch
anywhere below the bridge; if one seems necessary, the bridge is the wrong shape.

**The four SDK-side decisions are in `packages/aai-guest/CLAUDE.md`, "A phone
call is an ordinary session"** (the harness is what serves `/phone` in
production, and it is the guide with room); the platform's TwiML webhook route
is in `packages/aai-server/CLAUDE.md`, "Telephony" — the platform's TwiML webhook
route beside the four SDK-side decisions this guide used to carry (why pacing
stays ON and a barge-in sends the carrier's own `clear` frame, why the rates are
LEARNED from the `config` frame, why downsampling must low-pass first, and why
none of that contradicts "the host does not resample"), plus the two properties
every `CarrierCodec` owes and the two deliberate gaps.

## Pipeline-transport interleaving fuzz

`host/integration/pipeline-fuzz.integration.test.ts` drives the pipeline
transport through random event orderings (fast-check, no API keys; run by
`pnpm --filter @alexkroman1/aai test:integration`) and checks GLOBAL invariants
rather than specific outcomes — turn serialization, no callback after `stop()`,
no write to a closed provider session, reply-text integrity, and the strongest
oracle, validating every LLM request payload the way Anthropic and OpenAI do.
That last one is what surfaced the `capLlm` bug in the `maxHistory` row below.

**Its module doc is the guide to it** — the rules for adding an oracle, why
discovery and regression are separate jobs, what the generator produces, the
`preemptiveGeneration` arm's two honest limits, and why the coverage floors are
hand-rolled. Read it there; do not restate it here.

## Specs that observe a timer

**A spec that observes a TIMER runs on virtual time, never the wall clock.**
The pipeline-transport specs used to wait out real milliseconds
(`await sleep(60)`) to see whether a window had elapsed, which cost ~2.3s of
the unit run and, far worse, made them races: they were the specs that failed
first on a contended runner, and the flake named a timing spec rather than a
bug. It also capped what a spec could describe — every window had to shrink
to tens of milliseconds, so the dead-air cover was exercised at
`deadAirCoverMs: 1` and the SHIPPED 5s default was tested by nothing.
`useVirtualTime()` (`transports/_pipeline-transport-harness.ts`) installs
fake timers per file; drive them with `vi.advanceTimersByTimeAsync(ms)`.

**No scheduler had to be threaded through `PipelineTransportOptions` for
this, and the note that said otherwise was wrong.** The claim was that fake
timers could not compose with the fake providers because `_fake-llm.ts`
schedules its own `setTimeout` for `delayMs` — but that is the GLOBAL
`setTimeout`, which is exactly what `vi.useFakeTimers()` replaces, so it is
driven along with everything else. `vi.waitFor` composes too. Check the
cheap mechanism before building the seam.

Two things virtual time does break, both mechanical: `tick()` is a
`setTimeout(0)` and hangs until something advances the clock (use
`vi.advanceTimersByTimeAsync(0)`), and a `vi.waitFor` that polls for work
gated on a timer still polls in REAL time — prefer advancing by the amount
the work actually needs, which is deterministic and has no race to lose.

Deliberately NOT converted: `s2s-transport.test.ts`'s five `sleep(5)` calls.
Those are queue-settle yields, not timer observations — nothing is racing
them, and rewriting them would be churn.

## S2S property test

**`aai` has a fast-check PROPERTY TEST over the S2S stack**
(`host/integration/s2s-fuzz.integration.test.ts` plus `_s2s-fuzz-model.ts`,
`_s2s-fuzz-harness.ts`, `_s2s-fuzz-commands.ts`; same command, also keyless).
**The spec's own module doc and `_s2s-fuzz-model.ts`'s carry the design** — why
the SOCKET is the only fake (every S2S spec that predates it stubs a
neighbouring layer, and the bugs it found live in the seams), why nothing here
uses a TIMER (the hand-rolled walk it replaced could not re-run a
counterexample, and this one runs in ~150ms), and the ledgers the oracles read.
Four things worth knowing before adding to it:

- **Model-based COMMANDS, where the pipeline fuzz generates a script.** Legality
  lives in each command's `check()` against a model that IS the provider state
  machine, so an illegal frame is never generated and a counterexample contains
  only the commands that ran — reverting the three fixes reproduces them from
  `[session.error(rate_limited)]`, `[drop.transient, openSocket,
  session.error(session_not_found)]` and `[drop.transient]`.
- **Three properties, differentiated by a per-run `faultBudget`** (0 / 2 / 3):
  turns, reconnects, retirement. One combined property cannot serve both ends —
  at 2 faults per 40 commands a tool call rarely survived to be answered (the
  central oracle ran 7 times out of 80 executions), and at 0 there are no
  resumes to redeliver across.
- **A finding is only reachable if the run does not excuse it first.** The
  tool-answer exemptions (interrupted turn, client reset, retired session, link
  not ready, a SIBLING call of the same reply still running — results flush per
  reply as a BATCH) are broad enough to silence the oracle completely, so each
  increments a `skip:<why>` counter and the floors are on the CHECKED counts.
  `toolAnsweredAcrossResume` has been near zero through three separate
  mistakes; it is the floor that stands between a live oracle and a decorative
  one. `S2S_FUZZ_COVERAGE=1` prints the table. Note a resumed session inherits
  the dead socket's unanswered tool calls — that is what `session.resume` MEANS,
  and it is the premise the tool-answer oracle rests on.
- **The fakes' fidelity is where the false findings came from**, every time.
  Three drafts blamed the transport for behaviour their own fake had invented:
  an `executeTool` ignoring its abort signal (the real one settles promptly via
  `pTimeout({ signal })`, so `stop()` looked like it hung forever), one ignoring
  an ALREADY-aborted signal (what a `tool.call` after a client cancel receives),
  and one that rejected where the real executor always RESOLVES with a
  `serializeToolFailure(...)` string. Check the real collaborator's contract
  before believing a finding.

## Fixture replay testing (`host/`)

A **hybrid mock**: a real `Runtime` and tool executor over a mocked S2S socket,
replaying the recorded AssemblyAI messages in `host/fixtures/` through the real
orchestration layer. `createFixtureSession` / `fireFixtureMessage` /
`makeMockHandle` in `host/_test-utils.ts` are the three helpers, documented there.
Note `fireFixtureMessage` drives `S2sCallbacks` — the S2S WIRE contract, which is
a provider adapter and deliberately NOT the session's `report` surface.

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

  **Its defaults go through `omitUndefined`, because a spread lets a
  present-and-`undefined` key WIN over the default beneath it.**
  `agent({ greeting: undefined })` is already a compile error under
  `exactOptionalPropertyTypes` — but `agent({ name, ...opts })`, where `opts`
  is declared `{ greeting?: string; maxSteps?: number }`, is not, and that is
  how an options bag reaches `agent()`. It returned an agent whose `greeting`,
  `systemPrompt` and `maxSteps` were all `undefined` while every one of them is
  typed as REQUIRED on `AgentDef`: the agent opened on silence, ran with no
  system prompt, and the pipeline's `stopWhen` budget was `NaN` — with nothing
  anywhere reporting it. Making absent and present-and-undefined mean the same
  thing is what those fields' docs ("Defaults to …") already promise.
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
and each stage's EFFECTIVE SETTINGS — "which transport is this agent on" must
be answerable from one log line rather than inferred from the shape of the
message stream (`S2S <<` prefixes).

**Settings, not just kinds** (`host/providers/_provider-settings.ts`). The kind
alone (`stt: "assemblyai"`) names the vendor and nothing that decides behaviour,
and almost every such value here is a DEFAULT nobody wrote down: the endpointing
pair, the Voice Focus threshold, the connect budget, the gateway model id and
its `reasoningEffort`, the TTS voice. Those are exactly what a bad session gets
blamed on — a split utterance, a mute agent, background speech in the transcript
— and none of them appeared anywhere at startup, so confirming one meant
re-deriving the `??` chains by hand against a build you hope is deployed. A
default pipeline now prints:

```text
Session mode resolved {
  slug: 'tau2-pipeline', mode: 'pipeline',
  stt: { kind: 'assemblyai', model: 'universal-3-5-pro', minTurnSilenceMs: 1600,
         maxTurnSilenceMs: 3000, voiceFocus: 'near-field',
         voiceFocusThreshold: 0.9, connectTimeoutMs: 2500, maxConnectRetries: 2 },
  llm: { kind: 'assemblyai', reasoningEffort: 'none', model: 'qwen3-next-80b-a3b' },
  tts: { kind: 'assemblyai', voice: 'jane' }
}
```

The defaults come from the SAME `resolve*Settings` function the stage's opener
dials with (`sdk/providers/**` — pure descriptor data, so this costs none of the
vendor-SDK load time `lazyOpener` defers), never a second copy of the `??`
chains: **a settings log that can drift from the wire is worse than no log,
because it is believed.** A new provider adds its resolver there and one entry
in the stage table; the tables are per-stage because `ASSEMBLYAI_KIND`,
`ASSEMBLYAI_TTS_KIND`, `ASSEMBLYAI_LLM_KIND` and `ASSEMBLYAI_S2S_KIND` are four
different constants all equal to `"assemblyai"`.
