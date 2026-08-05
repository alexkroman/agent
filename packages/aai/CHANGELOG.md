# @alexkroman1/aai

## 5.8.1

## 5.8.0

### Minor Changes

- d140e9b: Add CloseableDb.reserve() for connection-affine Postgres work (advisory locks, session SET)

### Patch Changes

- d140e9b: createServer().close() drops idle keep-alive connections instead of waiting out their timers, so `aai dev` shuts down and restarts promptly. In-flight requests still finish.

## 5.7.0

### Patch Changes

- 56efab9: Stop studio Publish from claiming reserved `-preview` slugs, and refuse to derive a `-preview` project name from a directory
- 1c034af: Keep one guest sandbox per slug and per studio project across web-service replicas: a cross-replica registry lets a cold broker route to a live peer's guest instead of spawning a duplicate.

## 5.6.0

### Minor Changes

- f4ae66f: Redeploys now hand over blue-green: the agents-row change event boots the
  new deploy's sandbox and waits for its readiness before detaching the old
  resident, so a redeploy never leaves an empty slot and the next caller pays
  no cold start; old sessions drain in the background as before. The warm
  sandbox pool is deleted entirely (production always ran with it disabled):
  every spawn — agent, studio, inspect — boots directly from the published
  content-addressed harness snapshot image through one code path, and every
  sandbox is tagged with its real identity at creation. Modal sandbox memory
  snapshots slot into this single spawn path once the JS SDK exposes them.
- f4ae66f: Deployed agents now run as SERVERS — the "guest is a server" contract. The
  worker bundle (sha-256-verified in the guest) and the agent env arrive as
  files written into the sandbox before exec; readiness is the guest's public
  `/health`; and the platform's whole ongoing surface is a token-gated
  `GET /manage/status` + `POST /manage/drain` pair. No control channel exists
  on an agent sandbox: lifecycle is guest-owned (idle self-exit replaces the
  orphan timeout; a drained guest refuses new sessions and exits when empty),
  and a boot crash fails the spawn immediately with the guest's stderr. The
  JSON-RPC control channel remains for studio/inspect sandboxes only, which
  always run the current harness image. Combined with per-deploy image
  pinning, the platform↔deployed-agent contract is now an exec convention
  plus five HTTP endpoints, frozen per deploy.

### Patch Changes

- 77b0a80: Drop zero-length audio frames instead of treating them as user activity.
- 753665a: Remove latent footguns: fail-closed env parsing (PORT, SANDBOX_RETIRE_DRAIN_MS, AAI_GUEST_PORT), contained promise rejections in the host-mode handshake, guest RPC dispatch, harness listen, and studio chat body reads, pipeline provider credentials resolving from providerEnv, corrupt agent rows failing closed instead of reading as unclaimed, dead sandboxes no longer preferred by session routing, scrubbed app-db provisioning errors, refusing no-auth dev tokens alongside production config, and full numeric-entity decoding for S3 keys
- 77b0a80: Log guest stderr on boot failure, validate the resume sessionId, and stop a bundle spoofing its own deploy-time config.
- f4ae66f: ctx.db on the platform now connects directly from the guest sandbox: the
  app's own scoped Postgres credentials (role with pinned search_path,
  statement_timeout, and connection limit) are delivered as `DATABASE_URL` in
  the bundle/load env, and the bundle's runtime opens its own connection —
  exactly as `aai dev` does with a project `.env`. The host-proxied `db/query`
  RPC is removed, taking the last bundle-facing RPC out of the versioned
  harness↔bundle contract.
- f4ae66f: Stored agent configs are now opaque to the platform server. Strict config
  validation (`IsolateConfigSchema`) runs once, at deploy time, on the freshly
  extracted config; row reads assert only the fields the host consumes (`name`,
  `greeting`) and pass everything else through untouched. A future schema
  tightening can therefore never make previously-deployed agents unreadable.
- f4ae66f: Deploys are pinned to the harness snapshot image they ran against. The
  content-addressed image tag is recorded on the agents row at deploy time and
  the agent's sandboxes spawn from that image ever after, so platform upgrades
  (new harness, base image, or Node version) never change the runtime
  environment under an already-deployed bundle. Redeploying re-pins to
  current; an unresolvable pin falls back with a warning; pinned agents skip
  the warm pool.
- 8b622e8: Replace hand-rolled code with established libraries: HTML entity decoding via entities, <link> parsing via htmlparser2 (fixes entity-encoded hrefs and attribute values containing '>'), percent-decoded static asset paths in the dev server, a new internal createCoalescingRunner primitive, and use-stick-to-bottom for message-list auto-scroll (height changes no longer silently unpin the transcript).
- f4ae66f: Remove platform host mode (`?host=1` on deployed agents). The platform no
  longer runs any session in the server process: `/:slug/websocket` upgrades
  are always handshake redirects to the agent's live sandbox. This deletes the
  one path where the server's current SDK interpreted stored agent configs
  (`toRuntimeAgent`), a cross-version seam for already-deployed bundles. Host
  mode remains available under `aai dev`.
- f4ae66f: Remove the legacy descriptor-less S2S fallback in `buildTransport`. Configs
  predating the pipeline-by-default flip that reach transport construction with
  no resolved pipeline providers and no `s2s` descriptor now fail loudly with a
  clear error instead of silently running an AssemblyAI S2S session.
- 77b0a80: Fix four sandbox-lifecycle defects found by stress testing: a stale studio chat token signing the user out, a silent TTS drain timeout, an unhandled publish-sandbox failure, and an unreachable guest idle-exit override.
- 77b0a80: Reset the session idle timer on conversational activity instead of on raw audio frames, and don't auto-reconnect after an idle retirement.

## 5.5.1

### Patch Changes

- 1a6f800: Remove the S2S transcript.agent.delta accumulator: the event is documented but not implemented by the service, so the fallback could never fire. Records the measured behaviour instead — transcript.agent is omitted for both replies of a tool-call turn.

## 5.5.0

### Minor Changes

- a57905b: Pipeline provider stages are now individually optional: declare any subset of stt/llm/tts and unset stages are filled from the default all-AssemblyAI pipeline (agent({ llm: "claude-sonnet-4-6" }) swaps just the model). New top-level voice field on agent() picks the default pipeline's TTS voice (voice: "michael"), desugaring to tts: assemblyAITts({ voice }); it is a compile error alongside an explicit tts descriptor or s2s. The assemblyAIPipeline() spread is no longer needed on the golden path and remains for explicitness and region: "eu".

### Patch Changes

- 030b55f: Voice output rules now forbid contractions, and the default greeting/start-failure phrases spell them out, since TTS renders contractions poorly
- 6cca475: Remove the unused parseManifest/Manifest layer; toAgentConfig is the single config entry point (ProviderDescriptorSchema now lives in agent-config.ts; the /manifest subpath surface is unchanged).
- d303cfb: S2S: commit accumulated agent transcript deltas as the reply's final transcript when reply.done arrives without one, so the assistant turn still enters conversation history when the service omits transcript.agent (observed on tool-call follow-up replies).
- 41d53ae: Accept the S2S transcript.user.delta and transcript.agent.delta events, which were being dropped as unrecognised, and report per-reply audio/transcript accounting on reply.done so an empty reply is diagnosable

## 5.4.0

### Minor Changes

- cb2de62: Pipeline mode is now the default: an agent that declares no providers gets the all-AssemblyAI cascaded pipeline (assemblyAIPipeline()) injected at parse/config/runtime time. The S2S voice-agent API is now an explicit opt-in via the new s2s: assemblyAIS2s() descriptor (exported from the main entry and @alexkroman1/aai/s2s) — there is no longer any way to reach S2S by omission.
- 2198e2e: Vercel-idiomatic API: rename tool({ parameters }) to tool({ inputSchema }) and accept any Standard Schema convertible to JSON Schema (Zod remains the default), let ctx.generate take a Zod schema directly with a typed object result (generateObject parity), accept model-id strings for llm (creator/model via the Vercel AI Gateway, bare ids via the AssemblyAI LLM Gateway), add a system alias for systemPrompt, extend toolChoice with none and { type: 'tool', toolName }, and add InferToolInput / InferToolOutput / InferAgentState type helpers.
- 2198e2e: DX overhaul: rename the three assemblyAI stage factories to assemblyAIStt/assemblyAILlm/assemblyAITts (no aliases kept), brand provider descriptor types per stage so cross-stage assignment is a compile error, move cross-package infrastructure (createEpoch, createOwnedMap, parseWsUpgradeParams, env brands) off the root barrel onto @alexkroman1/aai/internal, drop the deprecated CustomEvent alias in aai-ui, document every public provider symbol, fix doc drift (AgentDef.llm descriptor wording, resumeSessionId persistence claim, ClientTheme defaults), add package READMEs, a real docs landing page, import-path module names in the API reference, aai templates command, and human-mode CliError hints.
- 1d76583: SDK polish: AgentParams is now a pipeline/S2S mode union — a partial stt/llm/tts triple, or s2s combined with a pipeline provider or pipeline-only tuning field, is a compile error whose message names the rule (previously these were runtime parse failures or silent no-ops). The system alias and llm model-id string shorthand now also work for raw configs that skip agent() (normalized in parseManifest/toAgentConfig). The default TTS voice is now jane (US-accented English); it was vera (UK), which put a UK accent on every agent that never chose a voice.
- 5174cb2: Curate the public API surface: internal plumbing is now tagged @internal (docs-hidden), provider barrels export every type their public signatures reference (KIND constants, Unsubscribe, AssemblyAITtsLanguage, default voices, OpenaiRealtimeVoice), the runtime barrel uses explicit named exports, aai-ui exports ClientConfig's tiers/WebSocketConstructor/Button variants and renames CustomEvent to AgentCustomEvent (deprecated alias kept), and stale doc comments are fixed (interruptionMinDurationMs and minTurnSilenceMs defaults, RuntimeOptions.fetch default, pipeline voice examples).
- aafe175: Default the AssemblyAI LLM Gateway model to gpt-5.5 (was qwen3-next-80b-a3b) and add a reasoningEffort option to the gateway LLM descriptor — unset, the model keeps its server-side reasoning default; set "none"/"minimal" to turn reasoning off

## 5.3.0

### Minor Changes

- 27c5963: Voice-agent defaults hardened against three failure modes measured across tau2-bench, EVA, and Full-Duplex-Bench v3: the agent may no longer describe an action as done without a successful tool result (EVA scored faithfulness 0.075 on claims like "your window seat is reserved" with no assign_seat call); spoken identifiers must be written in normal written form in tool arguments ("K dash 2" is K2, "Z K 3 F F W" is ZK3FFW); long tool results must be summarized rather than enumerated (30% of synthesized audio was discarded by barge-in). DEFAULT_MIN_TURN_SILENCE_MS raised 1500 -> 2000, which fixes a confirmed mid-utterance split on hesitant speech.

### Patch Changes

- 27c5963: Publish the greeting transcript once instead of twice: the fixed-phrase turns (greeting, start-failure line) reach TTS in a single call, so their interim `agent_transcript` was a byte-identical copy of the final — emitted final-first, the inverse of the documented partial-then-final order.

## 5.2.0

## 5.1.1

### Patch Changes

- b829155: Export `MAX_SLUG_LENGTH` from the shared slug contract (`@alexkroman1/aai/utils`) so callers that truncate to fit the slug shape no longer hard-code 64.
- ab577dc: Internal cleanup across the aai package: dedupe shared constants (WS_OPEN, WS_NORMAL_CLOSURE, tool User-Agent/Accept headers, default toolChoice), route JSON parsing and tool-arg coercion through the shared safeJsonParse/toArgsRecord helpers, share the TTS done-once latch between the Cartesia and Rime openers, fetch page-design stylesheets concurrently, drop the redundant web-search boundary re-scan, and fix manifest/validation drift: parseManifest no longer strips startFailurePhrase and requiredEnv, and assertPipelineTuning now covers startFailurePhrase.

## 5.1.0

### Patch Changes

- 8fb0a0d: web_search now falls back to DuckDuckGo's lite endpoint when the primary HTML endpoint returns a bot-detection challenge or HTTP error, detects the anomaly interstitial as a challenge, and sends browser-like Accept headers
- ac21a90: Close the client socket when a session hits its idle timeout. Previously session-core emitted an `idle_timeout` event and left the connection open; clients treat that event as informational and wait for a close, so the session, its provider sockets, and (on the platform) its Modal input slot were all held indefinitely.

## 5.0.1

## 5.0.0

### Major Changes

- e8fef4b: Narrow the public export surface: remove registry/wire internals from the provider barrels (ASSEMBLYAI_LLM_KIND, GATEWAY_KIND, OPENROUTER_KIND, ASSEMBLYAI_TTS_KIND, CARTESIA_KIND, RIME_KIND, gateway URLs, ASSEMBLYAI_TTS_HOST, OPENROUTER_BASE_URL, default-voice constants), EMPTY_PARAMS/ExecuteTool/SessionMode from the manifest barrel, duplicate createRuntime/Runtime/RuntimeOptions/safeFetch/RunCodeExecutor re-export paths from the runtime barrel, and the WebSocketConstructor test-seam type from aai-ui. Provider factories, their Options/Provider types, and \*\_API_KEY_ENV constants are unchanged.
- 30914c9: Remove the Vector store: ctx.vector, the vector: agent field, the @alexkroman1/aai/vector subpath (pinecone/inMemoryVector), the vector/\* guest RPC, the platform POST /:slug/vector route, and the platform-owned PINECONE_API_KEY. A future retrieval feature will be a Supabase (pgvector) store following the same path as ctx.db.
- e8fef4b: Remove the @alexkroman1/aai/patterns subpath (sequential, parallel, route, orchestrate, evaluatorOptimizer, generateStructured). The combinators had no template coverage and no known consumers; compose multi-step LLM orchestration directly over ctx.generate, converting Zod schemas with z.toJSONSchema() where structured output is needed.
- 30914c9: Guest architecture v2: the sandbox guest now runs Node (same runtime as the host and aai dev), from a harness-baked Modal snapshot image, and runs the COMPLETE agent — the harness (its own private workspace package, `aai-guest`, built into one self-contained `dist/harness.mjs`) embeds the SDK runtime and wraps the same `createServer` the dev server runs, so what executes in the guest matches `aai dev` almost exactly. Client voice sessions connect DIRECTLY to the sandbox's public `/websocket` tunnel endpoint (the same path `aai dev` serves), discovered via the `GET /:slug/client-config` broker; the platform's own `WS /:slug/websocket` serves host-mode only and answers plain upgrades with 410 + guidance. The host keeps a token-authenticated control channel (`/ws`, attached via the new `ServerOptions.upgrade` hook) for bundle loading, one-shot tool trials, the session-count probe idle eviction consults, and the guest's ctx.db proxy.

  BREAKING: `allowedHosts` and the entire per-agent egress policy are removed — `agent({ allowedHosts })` is no longer a field, and the SDK's tool-egress guard, guest-fetch-policy limits (`TOOL_FETCH_*`), and `AllowedHostsSchema` are gone. Tool code and providers `fetch` directly with open egress, identical in dev and production; the Modal container is the isolation boundary, and the network builtins keep their SSRF screen. Also removed: the NDJSON stdio transport, fetch relay, message delta protocol, heartbeat/watchdog machinery, per-call state shipping, and the host-side session relay. `RuntimeOptions.runCode` injects a real `run_code` executor (the guest supplies one; `aai dev` still refuses), and the client-config response gains an optional `sessionUrl` that aai-ui's session core re-fetches per reconnect attempt.

### Minor Changes

- c36ad60: Deploy-time credential preflight: deploys are rejected (400) when the agent's config requires a credential its stored env doesn't hold, derived from the provider descriptors plus the new optional `requiredEnv` field on `agent()`. The studio publishes with a warning instead (it has no secrets UI). `aai dev` now also warns when a required key resolved from the shell only, since it won't survive `aai deploy`.
- 9b95fc9: Type ctx.state: agent() infers the state shape from its state factory and tool() carries it, so ctx.state.foo is typed instead of unknown.
- 0c2bdbd: Add assemblyAIPipeline(), a one-call preset for the all-AssemblyAI cascaded pipeline; default the LLM gateway model; and replace the AssemblyAI TTS voice list with a checkable constant (the old doc-comment list named voices that do not exist).
- 25938b2: Extract shared concurrency primitives and adopt them across the stack: new `createEpoch` (staleness guard for async continuations) and `createOwnedMap` (map entries released by ownership token, so a stale teardown can't evict a successor's entry) exports, adopted in the host runtime's session/sink maps, the WebSocket handler, the platform slot cache, and the browser session core's generation counters. The pipeline transport's turn lifecycle (`turnController`/`turnSpoke`/`ttsAudioOpen`) is now an explicit state machine (`pipeline-turn-state.ts`) whose named transitions are the only mutation path, per-turn abort wiring uses native `AbortSignal.any` instead of the hand-rolled `linkAbort`, and the bespoke `Promise.race` timeout implementations were consolidated onto `p-timeout`.
- 293da11: `web_search` no longer requires `BRAVE_API_KEY`: it is now backed by
  DuckDuckGo's keyless HTML endpoint (scraping approach ported from
  openclaw's duckduckgo plugin, MIT). Every agent gets web search with zero
  configuration; the Brave Search implementation and its key handling are
  removed.
- 0c2bdbd: Network builtins skip the SSRF screen inside a real container; the screen stays for self-hosted runs where the host is someone's machine.
- 0c2bdbd: Generate the AssemblyAI gateway model catalog from the gateway's /v1/models endpoint, with per-model tools/stream/EU/liveness flags, and type assemblyAI({ model }) against it.
- 01cecc1: Simplify the default system prompt into a general-purpose voice agent base (speaking, listening, and tool-use fundamentals) instead of a phone customer-service/domain-policy prompt, so it works across many kinds of voice agents
- 0c2bdbd: Add agent syncState + useAgentState: the agent projects its session state and the client reads it, replacing the hand-rolled return-a-snapshot-from-every-tool pattern. Removes ToolResultMap.
- 293da11: The studio coding agent is now a Claude-Code-style agentic agent that runs
  INSIDE the project's own Modal sandbox, with the browser connected to it
  directly — mirroring the voice path. `POST /studio/projects/:project/
session` boots (or reuses) a guest sandbox through the same warm-pool
  machinery deployed agents use and returns the sandbox's public chat URL;
  turns stream browser→sandbox over SSE and never pass through the platform
  host. The loop runs in the guest on the caller's own key with tools over a
  real filesystem workspace — list/read (windowed)/write/edit/delete, glob,
  grep, bash (a real shell in the container), todo_write, test_agent, and
  the keyless web builtins — each with a user-friendly label served by the
  sandbox (`GET /studio/tools`) and rendered in the studio UI. End of turn,
  the guest syncs workspace edits and the conversation back over the
  authenticated control channel; test_agent builds via a guest→host RPC to
  the out-of-process build runner. The host-side chat loop, scan worker
  thread, and host tool implementations are removed — the SDK's
  `createServer` gains a `request` hook so the harness can serve the chat
  surface without a second HTTP server.
- fdd64ef: Add snapshotSessionNotes/restoreSessionNotes to the runtime for cross-replica session resume: the platform server can now persist a disconnected session's remember/recall notes and restore them when the session resumes on another host.
- 0c2bdbd: Add @alexkroman1/aai/tools: fetchJson, visitWebpage and webSearch callable from your own tool code, with the same screening and caps the model-facing builtins get.

### Patch Changes

- 5a599b2: Route a tool's `ctx.send` and `syncState` pushes to whichever client socket currently holds the session id, rather than the one captured when the tool was dispatched. A reconnect landing mid-tool-call sent both to the superseded socket; for `syncState` the lost push also recorded the projection as delivered, leaving the resumed client stale indefinitely.
- 0c2bdbd: Stop the type gate from blocking working agents: useToolResult defaults to a permissive result type, and generated projects run strict without noImplicitAny — the implicit-any family was 57% of the diagnostics coding agents had to repair and caught no real defects.
- 6fb3bc3: Fix hot-path concurrency bugs: TTS reconnect deadline + clean-close mute + stale FlushDone pairing, session resume takeover/overlap races, host-mode handshake frame loss + per-connection runtime leak, post-stop transport events, client-cancel tool abort, drain-window barge-in classification, false-interruption resume vs committed final, S2S error-before-close and tool.result redelivery after resume, tool timeout firing ctx.signal, per-agent tool-fetch concurrency parity, sandbox teardown closing live session sockets, orchestrator re-resolve identity re-check, NDJSON/pool/cold-spawn hardening
- 55e045b: Replace hand-rolled patterns with newer Node built-ins: util.styleText instead of picocolors in the CLI (dependency removed), one-shot crypto.hash() for SHA-256 digests, node:timers/promises for the dev-server listen retry, and an async-disposable WarmHarness (Symbol.asyncDispose + await using) that unifies the sandbox teardown triple across describeBundle, configureSandbox failure paths, and the studio sandbox.
- 0c2bdbd: Strip $schema and propertyNames from tool schemas sent to the AssemblyAI LLM Gateway — without it every Gemini model 500s on any agent that has tools.
- d4c2a10: Add voice-agent prompt rules drawn from EVA's itsm voice tasks: a policy-required follow-up write (assign the tier, log the interaction) is part of the action and must happen in the same turn as the write; an unmet prerequisite becomes the job, worked in order from step one and without narrating the policy; a date, time, window, or urgency is never the agent's to invent; and a validation error that spells out a required prefix has already answered the question, so correct a one-character confusable difference rather than asking the caller to confirm it.
- e8fef4b: Remove the internal loadProviderPackage helper (dead since provider SDKs became regular dependencies)

## 4.0.0

### Major Changes

- 3e21af9: Remove legacy code, dead exports, and silent fallbacks across the SDK, CLI, UI, and server.

  Breaking changes:

  - `@alexkroman1/aai`: removed the dead `MAX_VALUE_SIZE` constant and the unused `ASSEMBLYAI_STREAMING_URL` STT constant; removed the legacy STT model aliases `"u3pro-rt"` and `"universal-3.5-pro"` (use `"universal-3-5-pro"`); removed the dead `theme` manifest field and `HostConfigMessage` type; `PipelineTransportOptions.executeTool` is now required (it previously defaulted to a stub that threw mid-turn).
  - `@alexkroman1/aai-ui`: removed the dead `floatToPcm16` export.
  - `@alexkroman1/aai-cli`: removed the deprecated no-op `--skipApi` init flag; the global config dir no longer falls back to the pre-env-paths legacy path (macOS/Windows users authenticated at the old path will be re-prompted for their API key); an unreadable or malformed `.env` now fails loudly instead of silently running with no secrets.
  - aai-server (private): removed the legacy `POST /:slug/deploy` route (deploys go through `POST /deploy` with the slug in the body); a corrupt stored env record now fails the agent boot instead of degrading to an empty env; the platform default Vector factory is now required (no silent in-memory fallback).

### Minor Changes

- b50b0e9: Host mode accepts an sttPrompt in its config block, and the pipeline traces the STT→LLM boundary under AAI_DEBUG=1 (each STT partial/final, the committed turn text, and each raw AssemblyAI turn event with its end_of_turn/turn_is_formatted flags). DEFAULT_STT_PROMPT is exported and empty — biasing stays opt-in.
- 527c401: Remove the pipeline transport's endpoint-settlement layer (`endpointSettleMs` / `completeSettleMs` and the host-side settler) — every STT final now commits a turn immediately. End-of-turn detection moves into the STT provider: the AssemblyAI opener always sets `min_turn_silence` (default 1500 ms, override via `assemblyAI({ minTurnSilenceMs })`), and Deepgram's default `endpointing` rises from 100 ms to the matching 1500 ms.

### Patch Changes

- 9ad4e51: Recover from a false barge-in during a reply's playback tail: a noise-triggered interruption after the turn finished server-side used to kill the rest of the reply permanently (full transcript shown, voice cut mid-sentence, no resume). The false-interruption recovery window is now armed for playback-tail cuts too, with a continuation prompt that quotes the estimated last words the caller heard.
- b50b0e9: Filler no longer plays over a caller who is speaking: the hold phrase is skipped and dead-air cover re-arms while the caller holds the floor, so a short continuation that does not qualify as a barge-in is no longer talked over.
- 577b17a: Fix the user's barge-in utterance flickering in the UI: a final-triggered barge-in now re-emits the interim caption after the cancel, so the utterance no longer disappears for the settle window before reappearing as a committed message

## 3.2.0

### Minor Changes

- 9c9eadb: Retune the pipeline turn-taking defaults and the default voice prompt, measured against tau2's retail voice tasks.

  A clearly-complete STT final now settles for 1500ms rather than 500ms. One sentence is very often not the whole request — "How many t-shirt options do you have? Also, I want to return three items." produces a complete-looking final at the question mark, and committing there had the agent answer half the request while the rest of that same breath barged in and cancelled the reply. Measured on those tasks, every turn of every call died that way. The general settle window moves 1500ms to 2500ms for the same reason, and the barge-in duration gate is now on by default (`DEFAULT_INTERRUPTION_MIN_DURATION_MS`, 500ms) so room noise and the tail of the agent's own audio stop abandoning replies mid-word.

  The default system prompt gains voice-specific rules, each drawn from an observed failure: keep turns to one or two sentences and don't restate what the caller already heard; offer alternative identifiers in a single question; never re-ask for a value a third time without attempting the call; a homophone can't be resolved by asking the caller to repeat themselves, so ask for the spelling and trust it over what you thought you heard; answer public questions while identity verification is still outstanding; escalation is not an escape from a value you couldn't hear, and when the answer is a transfer, transfer and nothing else; when a tool takes a list, put every affected item in one call rather than looping per item; fetch the list containing an id _before_ the write that needs it, never after; and any dollar figure you are about to say out loud is math.

  `DEFAULT_BUILTIN_TOOLS` is unchanged. Trimming it to `["calculate"]` was tried, on the theory that the other three cost an LLM round trip before the agent says anything and a call cannot afford that. Measurement did not support it: the model under test never invoked `think` or `calculate` at all — not even when the prompt demanded a calculator for a dollar figure it was about to quote — so an unused builtin costs nothing, and the one paired comparison available favoured keeping `think`.

- 9c9eadb: Speak up when a pipeline session cannot start, and actually honor `errorPhrase`. STT and TTS open independently, so the common provider failure leaves the agent with a working voice and nothing to listen with — and it said nothing, handing the caller a line that sounds connected and never answers. A failed open now speaks `startFailurePhrase` (new; defaults to DEFAULT_START_FAILURE_PHRASE, `""` disables) and drains it before teardown. Separately, `errorPhrase` was never forwarded from the agent config to the pipeline transport, so an agent that set it — including setting it to `""` to disable the recovery phrase — silently got the default; it is now passed through like `holdPhrase`.

### Patch Changes

- 9c9eadb: Keep filler out of the conversation record, and truncate oversized relayed tool results instead of dropping them. The hold phrase and the dead-air cover are timing artifacts that exist so a tool chain doesn't sound like a dropped call; they were accumulated into the turn's text and persisted, so history filled with "One moment. Still working on that. Just a moment longer." as though the agent had said something — spending context on every later turn and showing the model its own filler as an example of its output. They now reach TTS and the live caption (which is built from what reaches TTS) but not `onDelta`, which feeds history, `ctx.messages`, resume, and the STT agent-context hint. Separately, an inbound `tool_result` over MAX_TOOL_RESULT_CHARS failed schema validation and was dropped, so the relay call it answered hung to `DEFAULT_RELAY_TOOL_TIMEOUT_MS` — it is now truncated with a `[truncated]` marker so the turn continues and the model can tell the record is incomplete.
- 9c9eadb: Order `reply_done` behind the audio pacer's queue, like `audio_done`. The pacer holds a reply's audio back to a bounded lead, so a reply that finished host-side still has seconds of speech queued — and `reply_done` overtook it, telling the client the turn was over mid-reply. A client that closes the turn's books on that boundary attributes the rest of the audio to the next reply: in the tau2 voice harness every agent turn reached the simulated caller as speech carrying no transcript, and the caller hung up on what sounded like dead air.
- 9c9eadb: Make a voice reply's transcript and audio reach the client together. Pipeline mode published a reply's transcript once, when the reply ended: a turn that opens with a tool chain speaks its hold phrase and dead-air cover tens of seconds before that, so any client pairing text with audio (live captions, a voice harness) had already played the audio by the time the words arrived. `agent_transcript` is now cumulative within a reply and sent as each piece of text reaches TTS; `aai-ui` renders it as the live assistant bubble and commits it to the conversation on `reply_done`. Host-mode sessions also opt out of audio pacing (`UNPACED_AUDIO_LEAD_MS`) — pacing assumes a client that plays at one second per second, and metering audio to the wall clock starves a programmatic client that keeps its own.

## 3.1.0

### Minor Changes

- 1749ca4: Add OpenRouter LLM provider: openrouter({ model }) in @alexkroman1/aai/llm routes through OpenRouter's OpenAI-compatible endpoint using OPENROUTER_API_KEY, giving pipeline agents access to hundreds of models addressed as creator/model.

## 3.0.0

### Major Changes

- 2b395b3: Remove the workflow() app kind, the sync-turn API (POST /sync, createSyncSession, createPttRecorder, the WebSocket audio-file upload path), text-only mode (tts: none(), audioOut), and the Slack send channel (send:, @alexkroman1/aai/send, the send_message builtin).
- 2236275: Move the platform to Supabase and replace KV with an opt-in per-app database.

  - **Blob storage**: agent bundles now live in Supabase Storage via its
    S3-compatible endpoint (`SUPABASE_S3_ENDPOINT` / `SUPABASE_S3_ACCESS_KEY_ID`
    / `SUPABASE_S3_SECRET_ACCESS_KEY` / `SUPABASE_STORAGE_BUCKET`), replacing
    Tigris.
  - **Secrets**: agent env vars are stored in Supabase Vault over
    `SUPABASE_DB_URL` (service-role Postgres). The master-key envelope
    encryption and `KV_SCOPE_SECRET` are removed.
  - **KV support is removed** — `ctx.kv`, the `@alexkroman1/aai/kv` providers
    (`memoryKv`, `fsKv`, `s3Kv`, `redisKv`), the `kv:` agent config field, the
    `/:slug/kv` HTTP API, and the guest `kv/*` RPC are all gone. The
    `remember`/`recall` builtins keep working, now backed by in-memory
    per-session notes.
  - **New: opt-in app storage (`ctx.db`)** — enabling storage gives an app its
    own Postgres schema + role in the platform's Supabase database, exposed to
    tool code as `ctx.db.query(sql, params)` (proxied over the `db/query` guest
    RPC). Enable it with the new `aai storage enable|disable|status` CLI
    command or the studio's Storage toggle; under `aai dev`, set `DATABASE_URL`
    in the project `.env`. Templates needing persistence (solo-rpg saves,
    debrief-workflow records) now use `ctx.db`; session-scoped template state
    moved to `ctx.state`.

### Minor Changes

- bb02ded: Three type-level hardenings: (1) branded env records (AgentEnv/ProviderEnv/HostCredentialEnv in sdk/env-types) make it a compile error for withHostCredentialFallback output to become ctx.env; (2) the host-guest NDJSON connection is typed by a per-direction RPC method map (RpcSchema / GuestRpcSchema) so method names and request params are compile-checked while untrusted wire data stays unknown; (3) Manifest is now derived from ManifestSchema (defaults live in the schema, type via z.infer) instead of a hand-declared duplicate.
- 08f2937: Simplify the client audio path: the push-to-talk recorder now uses the same capture worklet as the WebSocket mic (start/stop gating, stop-flush-ack instead of a fixed sleep, sample-rate assertion, dead-mic probe), PCM16 conversion and mic-open failure cleanup are shared helpers, the playback worklet's concealment ring uses bulk copies, and all client-audio timing constants (playback done wait, capture stop ack, playback buffer seconds) live in the shared constants module.
- bb02ded: Collapse the config-mapping layer into one canonical schema: AgentConfigSchema is now the single serializable agent-config shape flowing CLI -> server -> runtime unchanged. toAgentConfig strips an explicit host-only deny-list (tools, state) instead of copying fields, agent() derives its parameter type from AgentDef instead of re-declaring it, the server's IsolateConfigSchema extends AgentConfigSchema, and toRuntimeAgent passes the whole config through minus wire-only fields (provider descriptors now ride on the runtime agent). Type-level guards enforce each subtraction so a new config field flows everywhere by default.
- 2236275: Add region: "eu" to the AssemblyAI STT provider — routes both streaming and sync transcription to AssemblyAI's EU data-residency endpoints

### Patch Changes

- d917095: Fix session resume losing the agent's context (ctx.state): the browser client now reconnects with the server-issued sessionId instead of a bare resume=1 (so the server resumes the same session rather than minting a new id), and per-session tool state survives a disconnect for a resume grace window (SESSION_RESUME_GRACE_MS) on both the self-hosted runtime and the platform sandbox (deferred guest session/end) instead of being wiped the moment the old session stopped.
- 2236275: Migrate all sandboxing and deployment to Modal.

  Agent guest sandboxes now run as remote Modal Sandboxes (`modal-sandbox.ts`,
  via the `modal` SDK): network-blocked containers running the Deno harness,
  speaking the same NDJSON JSON-RPC protocol over the exec'd process's stdio.
  The gVisor (runsc) OCI backend, the dev-mode child-process fallback, and the
  fake-VM harness are all removed — Modal credentials (`MODAL_TOKEN_ID` /
  `MODAL_TOKEN_SECRET`) are now required to run sandboxes in dev and prod alike.

  The server itself also deploys to Modal (`modal_deploy.py`,
  `pnpm --filter aai-server deploy:modal`); the production Dockerfile, the
  Docker test image, and the Fly.io configuration/deploy pipeline are removed.

- eb9f662: Fix "Sync turn failed: malformed server response" when a turn's model emits an invalid tool call. The AI SDK surfaces an unparsable tool call as a `tool-call` stream part whose `input` is the raw argument string rather than a parsed object; the sync-turn runner shipped it verbatim in `toolCalls[].args`, the client's response schema rejected the whole body, and the workflow run died. Tool-call args are now coerced to a plain record (`toArgsRecord`, exported from `@alexkroman1/aai/utils`) on both the sync path and the WebSocket pipeline's `tool_call` observability frame, sync turns run the same tool-call repair the pipeline transport uses, failed/invalid calls are recorded with an error result instead of dangling, and the client's malformed-response error now names the offending field.
- 6cac47f: Fix AssemblyAI streaming TTS cutting replies short when the server acknowledges a flush with both an is_final audio frame and a FlushDone: the pair now counts as one acknowledgement, so done can no longer fire mid-reply, drop buffered sentence text, or let audio_done overtake segments still synthesizing.

## 2.0.0

### Major Changes

- e17fdc4: Remove the text-only agent mode: an agent is always a voice conversation, and a workflow never speaks.

  - `agent()` with `tts: none()` is now rejected at parse time (parseManifest, toAgentConfig, and the platform's IsolateConfigSchema) — speech-in, text/action-out apps are workflows.
  - `workflow()` no longer accepts a `tts` parameter; it always sets the internal `none()` sentinel.
  - aai-ui: `TextControls` is removed and `ChatView` always renders the voice `Controls`. `SessionCore`'s programmatic audioOut-aware APIs (`startRecording`, `sendAudioFile`) remain.
  - The `pipeline-text-only` template and the studio's text-only starter are removed.

- 6047231: Remove the per-agent sync client transport and simplify the app model to two
  kinds: **agents** (WebSocket chat/voice sessions) and **workflows** (one-shot
  `POST /sync` runs).

  Breaking changes:

  - `agent({ transport })` is removed. The default browser client always uses
    the WebSocket session for agents; workflows automatically get the run
    surface. `POST /sync` remains available as a programmatic API for pipeline
    agents.
  - `agent({ kind })` is removed — `workflow()` is the only way to define a
    workflow.
  - `ClientTransport` and `assertClientTransport` are removed; `assertAgentKind`
    no longer takes a transport argument.
  - `GET /client-config` no longer returns a `transport` field (`kind` decides
    the surface); older responses still parse — the extra field is ignored.
  - aai-ui: `SyncChatView`, `startSyncMicrophone`, `createUtteranceDetector`,
    and their option types are removed. `createSyncSession` and
    `createPttRecorder` stay (they power `WorkflowView`). The chat shell now
    uses the server-declared agent name when `client({ name })` is not passed.
  - Templates `sync-voice` and `push-to-talk-translator` are removed.
  - The `@alexkroman1/aai/workflow` subpath (pattern combinators) is renamed to
    `@alexkroman1/aai/patterns`; the old subpath is removed.

### Minor Changes

- 377ecd3: Re-arm the playback jitter buffer on underrun and conceal gaps instead of zero-filling them, report per-turn concealment counters in WebRTC's shape, pace server audio at a bounded lead, capture through an AudioContext at the STT rate (no worklet resampling), and detect a microphone that only ever delivers silence.
- 4051d7a: Two app modes — agents and workflows: new workflow() definition (audio in, action out: push-to-talk or uploaded audio runs one agentic loop over the sync transport with its own workflow system prompt, rendered by the default client's new run surface), plus ctx.generate (host-executed one-shot LLM generation for tool code, proxied out of the sandbox via the llm/generate guest RPC) and the @alexkroman1/aai/workflow combinators: sequential, parallel, route, orchestrate, evaluatorOptimizer.
- 158d5d5: Workflow default UI is now a pure execution surface: sync turn responses carry the turn's tool calls (SyncTurnResponse.toolCalls), and WorkflowView renders the transcript plus those tool calls with no greeting and no assistant messages.

### Patch Changes

- 7fc476d: Fix every sync turn failing with HTTP 415: the AssemblyAI Sync API request body is now hand-encoded multipart bytes, because a globalThis.FormData is stringified rather than encoded by the pinned undici the host fetch comes from.
- ed4f2e7: STT: stop inheriting the assemblyai SDK's 1000 ms streaming connect deadline, which covers socket open plus the server's Begin and failed healthy handshakes. The AssemblyAI STT opener now pins connectTimeout/maxConnectionRetries/connectionRetryDelay from STT*CONNECT*\* constants (2500 ms, 2 retries, 500 ms), overridable per agent via assemblyAI({ connectTimeoutMs, maxConnectRetries }).
- 89a032d: Pipeline barge-in now requires the agent to be audibly speaking rather than merely mid-turn. A reply that has not yet emitted audio cannot be spoken over, so an utterance arriving in that window is buffered and answered as a chained turn instead of aborting the reply in progress. Previously any utterance during a slow reply restarted the turn, and since each restart redid the work on a longer history it outlived the next re-prompt — a caller saying "hello? any update?" into the silence could starve the reply indefinitely. Once a turn has spoken it keeps the floor for the rest of its run, so a mid-reply TTS stall does not reopen the window.

## 1.16.0

### Minor Changes

- 5ea4cba: Keep session sockets warm with a 15s keepalive ping, and log the close code and any fatal session error so a dropped session is diagnosable from the host's own logs

### Patch Changes

- c261662: Pair the SSRF DNS-pinning dispatcher with its own undici at both tool-fetch call sites, fixing `TypeError: fetch failed` on every `fetch` made from an agent's tool code

## 1.15.0

### Minor Changes

- f87ff84: Add errorPhrase: pipeline agents now speak a recovery line when the LLM stream fails instead of going silent

### Patch Changes

- 9ffec74: Never silently fall back to S2S: forward pipeline providers based on the descriptors rather than the optional mode field, and log the resolved session mode once per runtime

## 1.14.0

### Patch Changes

- 1c57e05: Fix deployed pipeline agents rejecting holdPhrase and the other voice tuning fields: validate the runtime config against the effective providers, which the platform passes as options rather than on the agent object
- 4469856: Fix AssemblyAI streaming TTS lag in pipeline mode: flush per sentence so audio starts mid-reply instead of after the whole turn

## 1.13.1

### Patch Changes

- f662e45: Surface a provider-initiated STT socket close instead of going silently deaf. `createSessionShell` treated every clean (1000) close as expected, but only a close we initiate ourselves is — a graceful close from the provider (a session cap, an idle cutoff, an upstream deploy) still means no further transcripts will arrive. Because the `closed` latch stayed false, `sendAudio` kept forwarding frames to a dead socket: the session looked healthy, no error reached the caller, and the agent stopped responding to speech for the rest of the call. Closes now emit `stt_stream_error` for all four STT providers via a new opt-in `cleanCloseIsFatal`, keyed off the latch rather than the close code. TTS openers keep the lenient behavior, where a provider closing after it has finished sending audio is normal completion.

## 1.13.0

### Patch Changes

- 2b3c0e0: Fix all host-side egress failing with `TypeError: fetch failed`: the SSRF pinning dispatcher is built from this package's undici 8, but was handed to Node's built-in fetch (undici 7), which undici 8 rejects with `invalid onRequestStart method`. Pair the dispatcher with undici's own fetch.

## 1.12.0

### Minor Changes

- 83be5b2: Add transport selection to agent(): declare transport: "sync" (pipeline mode only) and the default browser client runs connectionless HTTP turns against POST /sync — VAD mic, text composer, and spoken-reply playback with no custom client.tsx. The transport choice is served pre-connection via the new GET /client-config endpoint (GET /:slug/client-config deployed) with the agent name and greeting; every lookup failure degrades to the WebSocket default. aai-ui exports the new SyncChatView shell plus fetchClientConfig/buildAgentUrl, and the aai dev Vite proxy now forwards /sync and /client-config so sync clients work under dev.
- bd4405a: Add a `get_page_design` builtin that fetches a webpage's raw HTML and CSS — markup with scripts/comments stripped, `<style>` blocks, and linked stylesheets — so an agent can study or mimic another site's visual design. Every request (page and stylesheets) goes through the SSRF-safe fetch; a blocked or failing stylesheet degrades to a per-sheet error. The studio coding agent now gets the tool alongside `visit_webpage`.

## 1.11.0

### Minor Changes

- a6bb262: Make `allowedHosts` declarable in `agent()` and enforce the same tool-fetch policy in `aai dev` as in production, from one shared implementation. Adds the missing `send`/`state` fields to the `agent()` parameter type.
- d72c86b: Add a zod-free `@alexkroman1/aai/utils` subpath export exposing the shared utilities plus the platform slug contract (`VALID_SLUG_RE`, `RESERVED_SLUGS`, new `sdk/slug.ts`). Client wire constants (`MIC_BUFFER_SECONDS`, `MIC_SEND_MAX_BUFFERED_BYTES`, `FILE_SEND_BACKOFF_MS`) and the `custom_event` relay caps now live in `sdk/constants.ts`; `isPathInside` is exported from the runtime. The CLI and UI re-export these from the SDK instead of carrying their own copies.
- 163cb6f: Add sync mode: connectionless HTTP turns with no WebSockets on either leg.

  Server side (`@alexkroman1/aai`): pipeline-mode runtimes gain
  `runtime.runSyncTurn()` and the self-hosted server a `POST /sync` route —
  one request per conversational turn carrying committed text or one
  endpointed utterance of PCM16 audio plus the client-held history. STT runs
  through the provider's one-shot batch capability (`transcribeClip`,
  AssemblyAI Sync API), the LLM loop runs host-side with the agent's tools,
  and TTS runs through the new one-shot `TtsOpener.synthesizeClip`
  capability (implemented for Cartesia via its `/tts/bytes` endpoint). The
  request/response schemas ship from `@alexkroman1/aai/protocol`.

  Client side (`@alexkroman1/aai-ui`): `createSyncSession()` (HTTP turns +
  history replay), `startSyncMicrophone()` (WebRTC `getUserMedia` voice
  capture through an inline AudioWorklet), and `createUtteranceDetector()`
  (pure energy-VAD utterance endpointing) — speech is endpointed in the
  browser and each utterance becomes one HTTP turn.

### Patch Changes

- 310eedb: Fix AssemblyAI TTS `language`: translate ISO 639-1 codes to the full names the streaming API requires, and reject unsupported ones at config time. Passing `language: "es"` produced a session that connected, reported ready, and was silently mute — the service refuses a bad value in-band after the socket opens. Bad values now fail in the CLI and the studio's test_agent instead.

## 1.10.0

### Patch Changes

- 3fe3eff: Harden unhandled-error paths across the SDK, CLI, and UI: missing WebSocket/stream/child-process error listeners, floating `void` promises without rejection handlers, unguarded JSON parsing, and event-handler throws that could crash the process or silently wedge a session now fail safely with clear errors.
- 5ddca41: Fix race conditions and concurrency issues across the stack:

  - **Session registry** (host): reconnect-resume no longer lets an old session's delayed teardown delete the resumed session's registry entries (delete-by-identity); idle timer can no longer re-arm after `stop()`; `remember` serializes its KV read-modify-write; OpenAI Realtime transport no longer double-emits `cancelled`.
  - **Pipeline transport**: turn epochs gate queued turns so they can't run after `stop()`/`reset()`/`cancelReply()`; interrupted-turn persistence no-ops after `reset()`; the dead-air cover timer is abort-aware; late TTS audio after a barge-in is dropped instead of re-advancing the playback clock; tool-call repair captures its own turn's abort signal; `cancelReply()` resets the endpoint settler.
  - **AssemblyAI TTS**: `cancel()` now actually cancels — the adapter drops the connection (suppressing stale audio/done/error events) and reconnects, so barge-in works and cancelled text can't splice into the next turn.
  - **Sandbox platform** (aai-server): slot session releases are identity-bound so a stale release can't idle-evict a redeployed agent's new sandbox mid-call; sessions re-validate the sandbox before starting; a failed sandbox VM start detaches from the slot instead of poisoning it; dead warm-pool harnesses fall back to a cold spawn; gVisor cleanup is properly idempotent.
  - **Studio**: all workspace mutations run under a per-project keyed lock (no more lost writes from concurrent tool calls or editor saves), and Publish re-reads the workspace instead of writing back a stale pre-build snapshot.
  - **Browser client** (aai-ui): a stale audio init can no longer unlock a newer one (orphaned live mic); the greeting replay respects turn boundaries; a server-initiated `reset` discards in-flight file uploads; stale playback-stop events can't resolve a later turn's drain early.
  - **CLI**: `NODE_ENV` preservation around Vite builds is refcounted (concurrent builds can't leak `production` into the process); config writes are atomic (temp+rename); a slug-less first deploy is no longer retried (no duplicate agents); the dev server watcher starts before the initial build, shutdown is idempotent, and restart retries a busy port; `fsKv` writes are atomic.

- 133642f: Log a pipeline LLM stream failure as one compact line with its HTTP status, URL, and provider request id instead of letting the AI SDK dump the raw error object (three nested stack traces plus the whole request body) to the console.
- fec3fa2: Performance fixes across the SDK, CLI, and UI: incremental esbuild dev-server rebuilds with cold-path fallback, backpressure guards on provider-facing WebSockets, linear OpenAI gateway stream repair with a pass-through fast path, bounded STT partial word scans, selector-granular React subscriptions in ChatView/MessageList, memoized theme and session objects, and instant auto-scroll while transcripts stream.
- 678556f: Fix voice-agent reliability, security, and correctness across the aai core:

  - OpenAI Realtime: server-VAD barge-in now flushes client playback (was talking over the user).
  - S2S transport: an unexpected idle close now surfaces an error instead of zombie-ing the session; post-cancel audio is dropped until the next reply.
  - KV: expireIn is now enforced on all backends (memory/fs/s3), not just Redis; size cap counts bytes not UTF-16 code units.
  - fsKv: key-traversal guard now rejects ../ escapes (and reads/deletes), plus a key-length bound.
  - Providers: Soniox/Rime sockets keep a crash-safe error guard through teardown; Rime/AssemblyAI TTS surface abnormal server closes; Cartesia drops in-flight audio past cancel; Soniox flushes a trailing final on quiet.
  - ws-handler: session-start failure and a createSession throw now send the client an error frame and close instead of hanging or crashing the host.
  - Pipeline: start() no longer proceeds after a provider-open failure; S2S file-upload replay is paced so audio isn't dropped past the socket buffer.
  - fetch_json caps response body size; lenientParse flags invalid known-type messages; ws-upgrade handles empty sessionId and '?' in query values; stream-repair drops stale content-length/encoding headers.
  - Dependencies: bump undici 7→8 (the SSRF-path dispatcher) and nanoevents 9→10, both majors; sweep the ai/@ai-sdk packages to their latest in-range patches; declare fast-check as an aai devDependency (was a phantom dep).

- 8a5ee8f: Replace hand-rolled utilities with established libraries (expr-eval-fork, p-event/p-timeout reuse, env-paths, use-sync-external-store, partysocket, picomatch, generic-pool, json-rpc-2.0, iron-webcrypto, argon2)

## 1.9.2

## 1.9.1

### Patch Changes

- 713025a: Pipeline mode: cover tool-execution dead air with time-based filler speech. holdPhrase only fired when a turn _opened_ with a tool call, so a model that spoke first and then chained tool calls left the caller in silence for the whole chain (15-24s in benchmark runs). Silence during tool execution now gets a filler after 2s regardless, repeating with exponential backoff until the model speaks again. `holdPhrase: ""` disables both.

## 1.9.0

### Minor Changes

- 0235618: Add AssemblyAI conversation context (agent_context) for Universal-3.5 Pro streaming: seed the agent greeting at connect and push each agent reply mid-stream so user turns are transcribed with the agent side of the dialog in context.
- 262f1e7: Add four host-side built-in tools and enable them by default: `think` (a
  private no-op reasoning scratchpad, per the spec Anthropic published for its
  tau-bench evaluation), `remember`/`recall` (session-scoped notes in KV, so
  confirmed IDs/codes/dates survive noisy voice transcripts), and `calculate`
  (a safe recursive-descent arithmetic evaluator — no `eval`, no code
  execution). When an agent does not set `builtinTools`, the new
  `DEFAULT_BUILTIN_TOOLS` (`think`, `remember`, `recall`, `calculate`) are
  enabled; setting `builtinTools` explicitly — including `[]` — overrides the
  default. The network built-ins (`web_search`, `visit_webpage`, `fetch_json`)
  and `run_code` remain opt-in.

  Host-mode (relayed) sessions now expose built-in tool schemas and guidance
  alongside the client-supplied tools, executing built-ins host-side instead of
  relaying them — so a tau2-style harness session gets `think`/`calculate`/notes
  for free. Name collisions resolve in favor of the custom or relayed tool: the
  built-in is dropped from both dispatch and schemas.

- c5a5351: Add pipeline-mode silence nudge: new silenceTimeoutMs and silencePrompt agent config fields make the assistant proactively take a turn after a period of user silence (capped at 3 consecutive nudges until the user speaks again)
- 0235618: Default the AssemblyAI streaming STT model to `universal-3-5-pro` (Universal-3.5 Pro Real-Time) instead of `u3pro-rt`. The legacy `u3pro-rt` alias is still accepted and maps to the SDK's `u3-rt-pro`. (The `assemblyai` SDK is already on `^4.36.3`.)
- 0235618: Replace the default system prompt with a customer-service / voice-agent prompt (hard rules, tool-calling contract, voice behavior, dual-control, process) that ends by introducing the domain policy. This prompt is prepended before any agent-specific / injected instructions.
- d718fe9: Export resolveLlm from @alexkroman1/aai/runtime and ASSEMBLYAI_LLM_API_KEY_ENV from @alexkroman1/aai/llm, so host applications (e.g. the platform server's browser studio) can resolve LLM provider descriptors without duplicating provider wiring.
- 2898f21: Pipeline voice UX: stream interim user transcripts to the client (user_transcript_partial) with speech_started/speech_stopped edges, resume replies after false interruptions (falseInterruptionTimeoutMs), and expose pipeline tuning knobs on agent() — minBargeInWords, interruptionMinDurationMs, endpointSettleMs, completeSettleMs, holdPhrase. LiveKit-parity default changes: completeSettleMs default 600→500 ms, Deepgram endpointing default 300→100 ms (now configurable via deepgram({ endpointing })).
- 882e7d9: Host mode now inherits the deployed agent's `stt`/`llm`/`tts` provider config, so a `?host=1` session runs the operator's configured pipeline (e.g. AssemblyAI Universal-3.5 Pro STT + LLM + TTS, with agent_context/voice_focus) with only the client's system prompt, greeting, and tools injected — instead of falling back to the default S2S path. The dev server passes its loaded agent as `hostBaseAgent`.
- e2ee4fd: Add voice-agent host mode: external clients can inject system prompt + tool schemas via config.host and receive tool calls to execute (tool_result), enabling harness-driven agents.
- 0d024e0: Add `gateway()` LLM provider factory routing through the Vercel AI Gateway, so pipeline agents can use any `"creator/model"` id (e.g. `zai/glm-4.6`) with a single `AI_GATEWAY_API_KEY`.
- d718fe9: Deployed agents accept ?host=1 WebSocket connections that override systemPrompt/greeting/tools, gated on the owner's API key (startHostSession gains an allowHost option so the platform can gate on ownership rather than AAI_ALLOW_HOST).
- ab38293: Add AssemblyAI LLM Gateway provider for pipeline mode: assemblyAI({ model, region? }) in @alexkroman1/aai/llm routes the LLM loop through the OpenAI-compatible gateway (25+ models) using ASSEMBLYAI_API_KEY
- d718fe9: New "send" provider type: an outbound channel the agent can post to, declared as `send: slack()` from `@alexkroman1/aai/send`. Declaring a channel registers a `send_message` builtin tool and allowlists the channel's host for sandboxed tool code; `openSender()` resolves descriptors into a fetch-based `Sender` that works on the host and inside the guest sandbox. First channel: Slack incoming webhooks (`SLACK_WEBHOOK_URL`).
- 82f8253: Performance pass across the SDK and UI.

  Host runtime: client WebSocket audio sends are now guarded by a buffered-bytes cap (a stalled client is closed instead of accumulating unbounded audio in memory), pipeline TTS text is coalesced to clause boundaries after the first chunk instead of one message per word, the ElevenLabs STT opener batches mic audio to ~100 ms frames like AssemblyAI, the silence nudger keeps one long-lived timer instead of re-arming per STT partial, hot-path debug logs are gated behind `AAI_DEBUG` (new `createConsoleLogger` export), the in-memory vector store uses bounded top-K selection, and the default KV is constructed lazily.

  UI: chat messages carry a monotonic `id` used as the render key (stable across the history-window slide), the chat list is memoized, new `useSessionSelector` export for narrow subscriptions, mic sends drop frames under WebSocket backpressure instead of queueing stale audio, the capture worklet batches ~100 ms of PCM per main-thread message (down from ~190/s), dedup hooks use watermarks instead of unbounded seen-sets, auto-scroll is rAF-deduped, and the playback worklet gained an aligned Int16 fast path.

  Note one public type change in `@alexkroman1/aai-ui`: `ToolCallInfo.afterMessageIndex` (an index that drifted once history slid) is replaced by `afterMessageId`, and `ChatMessage` gained a required `id`. Nothing in the templates or repo consumed the old field, but custom client UIs reading `afterMessageIndex` must switch to `afterMessageId`.

- d718fe9: One-shot transcription for short uploads: new `transcribe_file_start`/`transcribe_file_end` protocol messages buffer an uploaded clip host-side and transcribe it in a single request via AssemblyAI's Sync API (`syncTranscribe` from `@alexkroman1/aai/stt` — the preferred endpoint for files under two minutes), then run the transcript as one user turn. Non-AssemblyAI STT providers and longer files fall back to the realtime streaming path. `sendAudioFile()` in aai-ui picks the path automatically.
- fd5a54e: Update all dependencies to latest: Vercel AI SDK v7 (@ai-sdk/\* v4), Cartesia SDK 3.3, Deepgram 5.5, ElevenLabs 2.58, AssemblyAI 4.36; Pinecone peer range is now ^8.0.0. Tooling: Biome 2.5, TypeScript 7, Vite 8.1, Vitest 4.1.10, tsdown 0.22.
- a413caf: Concurrency hardening in the agentic loop: tool calls now receive a history snapshot and a turn-scoped AbortSignal (exposed as ctx.signal) that cancels on barge-in, reset, or session stop; duplicate reply.done frames mid multi-hop turn no longer end the reply early; a failed S2S resume emits a single connection error and cannot loop into repeated resume attempts; host-mode relay refuses duplicate in-flight toolCallIds and honors turn aborts; ws-handler no longer marks a session ready (or drains buffered frames) after the socket closed mid-start.
- 0c57887: Harden credential and SSRF boundaries: SDK network builtins now default to SSRF-protected fetch, provider credential resolution no longer falls back to the host process env, host mode is opt-in, the self-hosted server binds loopback by default, and DNS pinning no longer breaks TLS. The CLI refuses to send credentials to an unapproved serverUrl from .aai/project.json.
- 0235618: Enable AssemblyAI voice focus (noise suppression) by default: the streaming STT provider now sends `voice_focus: "near-field"` at connect. Configurable via the `voiceFocus` option (`"near-field"` | `"far-field"` | `"off"`); set `"off"` to disable.
- 115a88e: Voice benchmark reliability: preserve completed tool calls/results in LLM history across barge-in aborts (no more repeated or forgotten tool calls after an interruption), settle clearly-complete STT finals briefly instead of committing instantly (plus a longer fragment settle window) so hesitant multi-part requests aggregate into one turn, coerce stringified scalar tool arguments to their schema-declared types, raise the default maxSteps to 10, and overhaul the default system prompt for act-first tool calling, full multi-part request completion, and argument fidelity.
- d718fe9: Text-only agents: `tts: none()` runs pipeline mode without synthesis (STT → LLM, text replies). No TTS credential required; the config message stamps `audioOut: false`; aai-ui adds opt-in mic recording (`startRecording`/`stopRecording`), audio-file upload (`sendAudioFile`), a text-only default UI (record + upload + text replies), and an always-visible API endpoint chip (`ApiUrlChip`, `SessionSnapshot.apiUrl`) in every session mode.
- d718fe9: Add an AssemblyAI streaming TTS provider (assemblyAI from @alexkroman1/aai/tts), targeting the production streaming-tts.assemblyai.com endpoint. Shares ASSEMBLYAI_API_KEY with AssemblyAI STT and the LLM Gateway, so an all-AssemblyAI pipeline needs one secret.

### Patch Changes

- 4758dfc: Fix AssemblyAI streaming STT rejecting telephony audio with "Input Duration Violation". The provider now coalesces inbound PCM into 50–1000 ms frames (buffering ~100 ms, capping at 1000 ms, and flushing a ≥50 ms tail on close) before forwarding to AssemblyAI, which requires each streaming audio frame to fall in that window. Clients that stream standard 20 ms RTP frames (e.g. the tau2 harness) now work unchanged.
- 0f72bef: Refactor: split oversized source modules (session-core, runtime, pipeline-transport, deno guest harness) into focused sibling files. No behavior or public API change.
- bc62b75: Internal cleanup of the aai package: dedupe the header-WebSocket adapter and ToolSchema types across transports, extract a shared runReply scaffold in the pipeline transport, consolidate PCM16/base64/error-message helpers, replace per-audio-chunk idle-timer re-arming and per-chunk STT carry reallocation with cheap accumulators, serialize KV values once, move STT/TTS resolution onto registries, and remove dead API surface (S2sHandle.sendAudioRaw, Transport.updateSession, user_transcript.turnOrder).
- 7e67c24: Internal cleanup: shared safeJsonParse/LOG_PREVIEW_CHARS helpers, deduped s2s-transport connect and dev-server build paths, native base64 in the sandbox guest, single-source MAX_REQUEST_BODY_BYTES, and vendor-correct API-key fallback for pre-resolved STT/TTS openers. The aai dev server no longer prompts for an AssemblyAI API key when the agent uses no AssemblyAI provider.
- 8817f3f: Remove unused code and fallback paths: legacy host-guest RPC schemas, backward-compat aliases (`pendingKvRequests`, `handleKvResponse`), unused exports (`jsonLogger`, `touchSlot`, `S2sEvent`, `DEFAULT_THEME`, unused metric label types), legacy OpenAI Realtime beta event-name fallbacks, inert CLI flags (`--server`/`--yes` on commands that never read them), and over-exported internal types.
- 394867e: Fix a Cartesia TTS connect failure crashing the whole host process. `client.tts.websocket()` only returns the socket after connect resolves, so on a connect-time failure (e.g. the account is out of credits) the promise rejects before an `error` listener can be bound — and cartesia-js's `TTSEmitter._onError` does a bare `Promise.reject` (a fatal unhandled rejection) when the socket errors with no listener. The adapter now constructs `new TTSWS(client)` directly and binds the `error` listener before connecting, so the failure flows through the normal `tts_connect_failed` path and degrades only that session. As defense-in-depth, the `aai dev` host entry now installs a log-only `unhandledRejection` guard (mirroring aai-server).
- 8004ff8: Fix Cartesia TTS killing the session with a fatal `tts_stream_error` on a benign barge-in race. When a `cancel`/`flush` crosses the context's `done` on the wire, Cartesia emits a per-context 400 "Invalid context ID" error frame on the shared socket; the handler now recognizes dead-context error frames (and frames tagged with a non-active `context_id`) and drops them, while still surfacing genuine socket failures.
- 257a372: Load STT/TTS vendor SDKs lazily (cuts runtime import from 1266ms/137MB to 335ms/61MB), fix the OpenAI Realtime transport hanging when a socket closes before opening, and share the restartable-timer and registry-lookup helpers.
- 0bdb115: Fix barge-in not stopping TTS playback after synthesis completes: pipeline mode now tracks estimated client-side playback and emits cancelled (flushing the client audio buffer) when the user speaks while buffered audio is still playing, even after the server-side turn has finished.
- 578a840: host: suppress duplicate tool_call frame in relay+pipeline mode (was double-executing relayed tools)
- a252842: Bump dev dependencies: `tsdown`, `@biomejs/biome`, `@changesets/cli`, `knip`,
  `markdownlint-cli2`, `publint`, `turbo`, `@tailwindcss/vite`,
  `@vitejs/plugin-react`, `react`/`react-dom` (also widening the `aai-ui` peer
  range to `^19.2.8`), and the `@pinecone-database/pinecone` peer range to
  `^8.1.0`.
- bbb9d73: Bump production dependencies: `@ai-sdk/*` providers, `ai`, `assemblyai`,
  `@cartesia/cartesia-js`, `@deepgram/sdk`, `@elevenlabs/elevenlabs-js`,
  `hono`, `@hono/node-server`, and `vite`.
- 257a372: Derive required provider credentials from the provider registries instead of a hardcoded AssemblyAI check that ignored tts/s2s, and stop rebuilding the system prompt per session.
- d718fe9: S2S and OpenAI Realtime now send close code 1000 on an intentional close, so a 1005 in the logs unambiguously means the peer dropped the socket rather than our own teardown.
- a413caf: Pipeline/host latency: the greeting now starts as soon as the TTS provider connects instead of waiting for the slower STT connect; tool-call yields use setImmediate instead of setTimeout(0) (~2ms less overhead per call); the Vercel tool map is built once per session instead of per turn; provider sockets close in parallel on stop.
- 9750db7: Fix relayed tool calls failing with "invoked without a toolCallId" in host + pipeline mode. The sandbox/RPC `executeTool` wrapper dropped its 5th `callOpts` argument (which carries `toolCallId`), so the relay executor couldn't correlate the client's `tool_result` and rejected every call. The wrapper now forwards `callOpts` to the RPC executor. Latent until host mode began running the STT→LLM→TTS pipeline (S2S sourced the id from a different path).
- cb2821c: Fix 'unsupported reasoning metadata' warning in pipeline mode: replace smoothStream with a text-only word-coalescing transform so Anthropic thinking signatures on reasoning parts survive multi-step tool turns
- 9aed108: Fix uncaught exceptions that could crash the host process: shim assemblyai@4.36.3's discardPendingSocket so a timed-out streaming connect no longer emits an unhandled ws 'error' ("WebSocket was closed before the connection was established"), attach error handlers to HTTP upgrade sockets, and destroy unmatched upgrade sockets instead of leaving them dangling.
- 257a372: Fix pipeline false-interruption recovery firing over a still-talking user, cap consecutive resumes, close the speaking edge when an utterance never commits, and keep a barge-in partial's caption from being blanked by the cancel that follows it.
- 257a372: Make RuntimeOptions stt/llm/tts descriptor-only, removing the pre-resolved-opener escape hatch, the opener.name sniffing it required, and the duplicated raw-descriptor channel in the transport factory.
- 860bb7d: Refactor pipeline provider internals: extract a shared session shell for STT/TTS openers, define each provider's API-key env var once next to its kind tag, and make the LLM resolver table-driven. No behavior changes.
- d718fe9: Repair the AssemblyAI LLM Gateway's id-less streaming tool_call deltas so gateway-backed pipeline agents survive tool calls
- 7240ce5: Pipeline mode: add a configurable `minBargeInWords` option (default 1, preserving instant barge-in) that requires the interim STT transcript to reach N words before interrupting the agent — raise it to ignore one-word backchannels while the agent speaks. Below-threshold _final_ transcripts while the agent is speaking are ignored the same way. Also persist the agent's spoken-so-far text on interruption (flagged `[interrupted]` in history) so the next turn's LLM knows it was cut off, instead of discarding it — unless nothing but the guaranteed hold phrase was spoken, in which case nothing is persisted.
- f22b0f4: Pipeline mode turn-taking overhaul so the agent stops cutting itself off and stops dropping the caller mid-sentence (root causes of a "the agent went silent" failure in tau2 voice runs):

  - **Endpoint settle window** (`endpointSettleMs`, default 700ms): disfluent, in-the-wild speech now commits as one turn. Previously every STT `final` started a turn immediately, so a mid-utterance pause, self-correction, or false start ("find a two-bedroom in Austin… actually make it Dallas") fired a turn on the pre-correction fragment — and a second `final` then barged in on that turn, producing wrong tool calls, duplicate calls, and responses that began before the speaker finished. Follow-on finals/partials inside the window are aggregated into a single utterance. A clearly-complete final (terminal punctuation, no trailing continuation cue) commits immediately, so clean requests pay no added latency. Set `endpointSettleMs: 0` to disable.
  - **Sub-threshold finals are no longer dropped.** A short final spoken while the agent is talking used to be discarded as a "backchannel," silently losing real short answers (a "yes", a ZIP). It is now transcribed and answered as a deferred turn once the current reply finishes.
  - **`DEFAULT_MIN_BARGE_IN_WORDS` raised from 1 to 2** so a single word — a backchannel, a cough transcribed as one token, or the leading fragment of the caller's own turn — no longer cuts the agent off mid-sentence. (Combined with the previous change, sub-threshold speech is deferred, not lost.)
  - **Voice output rule** added: when the caller spells a name/email/ID or reads out digits, the agent confirms briefly instead of reading the whole thing back letter by letter — long readbacks were slow and invited interruptions.

- 0bb1a20: Guarantee a hold phrase during tool execution. When the model opens a turn with a tool call and no preceding speech, the pipeline now deterministically speaks a short filler ("One moment.") before the tool runs — so the caller never hears dead air even if the model skips the prompt's tool preamble. Fires at most once per turn and is suppressed when the model already spoke; configurable via the stream handler's `holdPhrase` (set `""` to disable). This also makes tool-first turns produce speech, so they flush cleanly instead of relying on the silent-turn path.
- 7d4a193: Fix an OpenAI Responses API 400 ("Item 'msg*...' of type 'message' was provided without its required 'reasoning' item: 'rs*...'") on multi-turn tool calls in pipeline mode. Persisted-history reasoning stripping is now conditional: reasoning parts that carry provider metadata needed on replay are kept — OpenAI reasoning items (`openai.itemId`) required alongside their message/tool-call items, and Anthropic thinking/redacted-thinking (`anthropic.signature` / `anthropic.redactedData`). Only metadata-less reasoning traces (the ones that triggered the Anthropic "unsupported reasoning metadata" warning) are still stripped.
- 5bf4d41: Persist tool calls and their results across turns in pipeline mode. Previously only the spoken transcript survived into the next turn, so the model lost the raw results of earlier lookups (a user id, an order id) and had to re-derive them. The pipeline now keeps a Vercel AI SDK `ModelMessage` history and appends each turn's `streamText` step messages (assistant tool-call + `tool` result + text) — the SDK-idiomatic way — so tool context carries forward. Conversation memory was extracted into a focused `pipeline-history.ts` module (text view for the client/resume/tool-context; ModelMessage view for the LLM). Also fixes the test LLM fake to report `finishReason: "tool-calls"` on tool steps so multi-step response messages reconstruct correctly.
- ad295be: Adopt two Vercel AI SDK features in the pipeline instead of hand-rolling / going without:
  - `experimental_transform: smoothStream({ chunking: "word", delayInMs: null })` coalesces LLM text deltas into whole words before they reach TTS (cleaner than raw sub-word tokens), with no added streaming latency.
  - `experimental_repairToolCall` re-derives valid tool arguments (via `generateObject` constrained to the tool's JSON Schema) when the model emits a schema-invalid tool call, instead of failing the turn. Unknown-tool errors are passed through; a failed repair falls back to the original error. Lives in a focused `pipeline-repair.ts` module.
- d22d9f8: Fix pipeline turns stalling ~10s ("TTS flush timeout") on turns that produce no speech. A tool-call-only turn sent no text to the TTS context, but the transport still called `flush()` and waited for a `done` event the provider never emits for an empty context — burning the full `PIPELINE_FLUSH_TIMEOUT_MS` every silent turn. The flush/await now runs only when the turn actually produced agent text.
- 8f2093b: Strip `reasoning` parts from assistant messages persisted to the pipeline's LLM history. Reasoning is an ephemeral per-turn trace, not conversation the model should re-read; replaying it (introduced with cross-turn tool memory) also made the Anthropic provider warn "unsupported reasoning metadata" on every subsequent request because the persisted reasoning carries no valid thinking signature. Assistant messages that contained only reasoning are dropped entirely.
- 296a874: Add an optional `temperature` to the pipeline (`PipelineTransportOptions.temperature`), forwarded to `streamText`. It's omitted from the request unless explicitly set, so models that don't support it (e.g. the Claude 5 family, which ignores temperature and warns on every call) stay quiet, while temperature-capable models can opt into deterministic sampling (e.g. `0`) for consistent tool arguments and policy following.
- 752af3d: Strengthen the default voice-agent prompt's ASR-robustness guidance (voice-specific; defers all policy/identification specifics to the host-injected domain policy). On a failed lookup of a spoken value (name, email), the agent now stops retrying the mis-heard value and asks the customer to spell it, confirms, then searches again — or switches to another identification method the policy allows. Also: ask the customer to repeat anything not clearly caught instead of acting on a rough transcription, and vary turn openers instead of repeating the same acknowledgment. Patterns adapted from LiveKit's voice-agent prompting guide.
- 38f02fa: Teach the default agent prompt to recover from non-argument tool errors instead of looping. A state error (e.g. "order cannot be modified" because it isn't pending) now instructs the agent to re-read the record's status and switch to the action the policy allows — never to repeat the same tool call with the same arguments, which previously looped into a too-many-errors termination in tau2-voice runs.
- d718fe9: Fix AssemblyAI LLM Gateway streams dying on Claude models: the gateway's final usage-only chunk carries choices: null where the AI SDK schema requires an array, killing the turn after the reply had already streamed.
- 82f8253: Stop allocating per STT partial in pipeline turn-taking. `countWords` now scans instead of `split(/\s+/)`, and the final-path barge-in gate uses a new `hasMinWords` that stops as soon as the threshold is met — partials arrive several times a second and grow with the utterance, so the old word array was garbage on a latency-sensitive path. The word helpers moved to `pipeline-text.ts`.

  Also fix TTS text coalescing stranding speech across a tool call. Batching only ever deferred text that more text was coming for, but nothing released the buffer at a segment boundary, so a short unpunctuated fragment ("Sure, let me") held its tail for the whole tool-execution window — the caller heard the opening words, then dead air, since `holdPhrase` is suppressed once the model has spoken. The coalescer now exposes `boundary()`, called on `text-end` and before a tool call, which forwards the buffer and re-arms the immediate-first-chunk allowance so the post-tool reply's opening words are not batched either.

- 257a372: Fix deployed agents silently losing the default cognitive builtins, remove dead KV/Vector HTTP handlers and wrong-vendor API-key fallbacks, and reuse shared helpers for PCM views, JSON parsing and error formatting.
- d718fe9: AssemblyAI STT agent_context: keep the tail when trimming to the 1750-char cap, so an over-long agent reply keeps its closing question instead of dropping it.
- d718fe9: Fix text-only agents (tts: none()) rendering the voice UI when deployed: readyConfig read agent.tts, which the platform never sets since it passes providers as runtime options.
- 2fd1078: Code-quality sweep: reuse shared helpers (errorMessage/toolError, provider utils, TTL cache), remove dead code and leftover diagnostics, fix a session-state leak, cut hot-path allocations (base64 zero-copy, persistent playback worklet, client asset cache), and single-source defaults (DEFAULT_MAX_STEPS, slug regex).
- 711edeb: Security: the `run_code` builtin no longer executes on the host via `node:vm`.
  `node:vm` is not a security boundary — its wrappers still exposed the host
  `Function` constructor through the prototype chain, allowing a
  `console.log.__proto__.constructor("return process")()` escape to the host
  process (env/secrets + RCE). `run_code` now runs only inside the guest sandbox
  (gVisor/Deno), where the OS-level isolation is the real boundary. The host-side
  `executeInIsolate` helper is removed from the `@alexkroman1/aai/runtime` export.
  In the self-hosted path (`aai dev`), which has no sandbox, `run_code` returns an
  error instead of evaluating code on the host.
- 3db093f: Internal refactor: split oversized modules at natural seams (no behavior change). `host/runtime.ts` → transport construction extracted to `host/runtime-transport.ts`; `host/transports/pipeline-transport.ts` → STT/TTS provider lifecycle extracted to `host/transports/pipeline-providers.ts`; `aai-server/sandbox-vm.ts` → guest KV/Vector/fetch RPC surface extracted to `sandbox-guest-rpc.ts`. Oversized test files split alongside.
- 79e51cb: Harden connection-churn paths: cancel in-flight session start on disconnect, abort tool-call repair on interrupt, clean session maps on stop, release provider socket listeners, and cap S2S resume attempts.
- d718fe9: Harden the one-shot file-upload path: cap transcribe_file_start's sampleRate (memory-DoS guard), byte-budget the pre-ready WebSocket buffer so a whole upload survives session startup, auto-finalize fully-received uploads, discard in-flight transcriptions on reset/cancel, and mark turn-level transcription failures as non-fatal errors so the client session stays usable. The browser session core gains matching guards: uploads and the mic are mutually exclusive, resets abort in-flight uploads, and non-fatal server errors show a banner without ending the session.
- cf56703: Simplify internals with modern built-ins and existing deps: `Promise.withResolvers` + `p-timeout` for the TTS flush wait, S2S/OpenAI Realtime connect races, and the host-mode relay executor; `fs.cp` for scaffold layering, `stream/consumers` `text()` for stdin, and shared JSON file helpers in the CLI.

## 1.8.3

## 1.8.2

### Patch Changes

- bb06b4e: Fix S2S tool calls arriving with empty args. Strip the $schema keyword from Zod-generated JSON Schema for tool parameters — some S2S providers ship the dialect URI to the underlying model and emit tool calls with empty args even when required params are listed. Also accept both 'arguments' and 'args' field names on the wire. Pipeline transport now surfaces tool-result stream parts as tool_call_done so the client UI flips pending → done.

## 1.8.1

### Patch Changes

- ba8effb: Make OpenAI Realtime usable end-to-end on gpt-realtime-2:

  - Accept GA-renamed audio/transcript server events (`response.output_audio.{delta,done}`, `response.output_audio_transcript.{delta,done}`) alongside the legacy `response.audio.*` names so audio and transcript reach the client.
  - Trigger the agent's `greeting` on connect by sending a one-shot `response.create` with quoted instructions, and honor `skipGreeting` so resumed sessions don't replay it.
  - Coalesce `response.create` across multiple `sendToolResult` calls in the same tick. Multi-tool turns previously sent one `response.create` per tool, the second of which OpenAI rejected as `conversation_already_has_active_response`, stranding the turn so the model never received the tool results.
  - Log unhandled event types and the full payload of `error` events to make silently rejected `session.update` fields visible.

- f4cc5ef: Migrate OpenAI Realtime transport to GA API schema (gpt-realtime-2). Drop OpenAI-Beta: realtime=v1 connect header and update session.update to session.type=realtime, output_modalities, and nested audio.input/audio.output with audio/pcm format.

## 1.8.0

### Minor Changes

- a7384ad: Add OpenAI Realtime API as a pluggable s2s: provider via openaiRealtime() from @alexkroman1/aai/s2s

### Patch Changes

- cc013df: Log session.error code+message at warn level (was hidden — only the type was logged), capture session id from session.updated.config.id (the success-path message; session.ready is no longer sent there, leaving resume permanently disabled), and remove the broken time-since-session-ready check from canResumeAfter that prevented resume on any session older than 25s.

## 1.7.1

### Patch Changes

- 3c711da: Stop per-frame debug log spam when S2S socket is closed; sendAudio now silently drops frames matching sendAudioRaw and pipeline/STT behavior. Closure is still logged once via the WebSocket close event.

## 1.7.0

### Minor Changes

- 07b4263: Pluggable KV and Vector backends. New subpath exports @alexkroman1/aai/kv and @alexkroman1/aai/vector. New ctx.vector tool context field. Pinecone (integrated inference) and Redis/S3/fs/memory backends ship out of the box.

### Patch Changes

- b79855d: Change S2S/agent API base URL to wss://agents.assemblyai.com/v1/ws

## 1.6.1

### Patch Changes

- da84b47: Move @ai-sdk/_ LLM provider packages from optional peerDependencies to dependencies. Self-hosted deployments no longer need to install the @ai-sdk/_ packages separately, and prod deploys (where pnpm install --prod previously stripped optional peer deps) now resolve them reliably.

## 1.6.0

### Minor Changes

- fd3a167: Pluggable Vercel AI SDK LLM providers in pipeline mode: add openai, google, mistral, xai, groq typed factories alongside the existing anthropic. Each is a { model } descriptor; the host resolver lazy-loads the corresponding @ai-sdk/\* package via createRequire. All six AI SDK packages move to optional peer dependencies, so self-hosted users only install the ones they actually use; the managed server installs all six as direct deps in aai-server.
- c8707d6: Add ElevenLabs Scribe (scribe_v2_realtime via @elevenlabs/elevenlabs-js) and Soniox (stt-rt-v3 via direct WebSocket) STT providers alongside assemblyai and deepgram. Both follow the existing typed-descriptor pattern; agent bundles stay free of provider SDKs and the host resolver constructs the live session at createRuntime time.

### Patch Changes

- 149786b: Auto-resume AssemblyAI S2S sessions after transient WebSocket closes (1005, 1006, 1011, 3005) using session.resume within the 30s server window. Drops the in-flight reply via onCancelled so the session unblocks; falls back to the existing 'connection' error on fatal codes (1008/3006/3007/3008/3009) or when resume fails.
- 877348c: Pipeline mode: insert separator between LLM text segments split by a mid-turn tool call so consecutive deltas don't fuse into '...up.Got it' in the transcript and TTS output.

## 1.5.1

### Patch Changes

- fbb3816: Add type: "function" to tool schemas in S2S session.update payload — AssemblyAI's S2S API rejects tool objects without it.

## 1.5.0

### Minor Changes

- 58c5c75: Consolidate session.ts + pipeline-session.ts into a unified SessionCore with two transport strategies (S2S, pipeline). Switch connectS2s to typed callbacks (removing the nanoevents-backed S2sHandle emitter) and flatten client→server→provider dispatch from four layers to two. Wire format is JSON text events + raw PCM16 binary audio frames — the existing public protocol is unchanged. Adds Deepgram as a pipeline-mode STT option and Rime as a pipeline-mode TTS option.
- 868b85e: Plumb agent maxSteps and toolChoice config into pipeline mode streamText
- 58c5c75: Add Deepgram as a pipeline-mode STT provider option
- 58c5c75: feat(aai): add Rime as a pipeline-mode TTS provider option

### Patch Changes

- a361363: Fix Rime TTS provider: correct WebSocket host (users-ws.rime.ai), JSON message protocol on /ws2, longer first-audio timeout so the greeting plays. Default voice for cartesia() and rime() so they can be called with no args.

## 1.4.5

### Patch Changes

- 07dc8fb: Log raw reply.done arrivals from the S2S service (sid, status) and warn when the S2S socket closes while a reply is still active, so silent drops are visible server-side.
- 2ca5d1f: Instrument slow reply_done dispatches with warn-level logs (session id, duration, hadTurnPromise) to help diagnose event-loop starvation under load.

## 1.4.4

### Patch Changes

- 74341a4: fix(aai): dedup duplicate S2S reply.done and speech.stopped events to prevent client-side cascades in the voice session wire protocol

## 1.4.3

### Patch Changes

- 62d5a99: Fix pipeline mode: play greeting, emit a single agent_transcript per turn, open TTS at the client's playback sample rate, stop the Cartesia adapter from eagerly rotating its context (which was silently dropping in-flight audio chunks), and skip the wire `context.cancel()` when the context is already final on Cartesia's side (avoids a benign 400 that was killing the session).

## 1.4.2

### Patch Changes

- f877a6f: Fix pipeline mode: play greeting, emit a single agent_transcript per turn, open TTS at the client's playback sample rate, and stop the Cartesia adapter from eagerly rotating its context (which was silently dropping in-flight audio chunks).

## 1.4.1

### Patch Changes

- 63de397: Pass explicit baseURL to createAnthropic so the SDK's loadOptionalSetting returns before reading process.env['ANTHROPIC_BASE_URL']. The Deno platform server runs without --allow-env, and the missing baseURL caused pipeline-mode sessions to crash on first use.

## 1.4.0

## 1.3.2

## 1.3.1

### Patch Changes

- 5a9f3d5: Pipeline session concurrency fixes: serialize turns across duplicate STT finals, bound TTS flush with abort+timeout, cascade provider errors to terminate session, atomic provider open, snapshot conversation history in tool executions.

## 1.3.0

### Minor Changes

- f1a9764: Internal: manifests now classify session mode (`s2s` | `pipeline`) at parse time, and expose optional `stt`, `llm`, and `tts` fields on the `Manifest` type. Groundwork for upcoming pluggable provider support — no user-visible behavior change yet.

### Patch Changes

- c95212a: Fix runtime crash when loading the host runtime without the provider SDKs installed. `ai`, `assemblyai`, and `@cartesia/cartesia-js` are now regular dependencies instead of optional peer dependencies — the runtime eagerly imports `pipeline-session.ts`, so they were already required at module load even for S2S-mode agents. Optional peer deps described a design the code didn't enforce; now the metadata matches behavior.
- f1a9764: Fix PipelineSession: thread agentConfig.maxSteps into streamText via stopWhen: stepCountIs(n). Vercel AI SDK v6 defaults to a single step, so multi-step tool use would silently terminate after the first tool-result.
- f1a9764: agent() helper accepts stt/llm/tts fields directly, removing the need for the spread workaround in pipeline-mode agents
- 0231114: Simplify pipeline-session state management and parallelize provider open. Removes redundant PipelineState variable (equivalent to turnController != null), opens STT+TTS concurrently via Promise.allSettled (halves session-start latency), and cleans up either session if one open fails or the session aborts mid-open.
- 8a79282: Add sendAudioRaw to S2sHandle for batch-encoded audio frames

## 1.2.3

### Patch Changes

- 6a44b5b: Republish after the 1.2.2 release workflow failed (broken lockfile under `pnpm/action-setup@v6`). Also: `aai init` now skips deploy when `pnpm install` fails, so users see the real install error instead of a cryptic Rolldown `@alexkroman1/aai` resolution failure.

## 1.2.2

### Patch Changes

- 534122c: Harden secrets: PBKDF2 key hashing, versioned encryption, per-agent HKDF salt, env size limit

## 1.2.1

### Patch Changes

- 7af69b8: Fix gVisor/Deno binary discovery in distroless Docker images

## 1.2.0

### Minor Changes

- ed0dfbb: Add allowedHosts manifest field and host-proxied fetch for sandbox agents

### Patch Changes

- 231ebc1: Fix Docker build (missing unzip, CI=true for pnpm) and add test:adversarial command with CI integration

## 1.1.0

### Minor Changes

- 5cda7c5: Add ctx.send for real-time tool-to-client events

  Tools can now push arbitrary events to the browser client via `ctx.send(event, data)`. Events flow over the existing WebSocket as `custom_event` messages. The new `useEvent` React hook subscribes to named events. Migrated solo-rpg, pizza-ordering, dispatch-center, and night-owl templates from `useToolResult` to `ctx.send` + `useEvent`.

### Patch Changes

- 41fab1a: Remove dead code: unused exports, wrappers, and test hooks

## 1.0.6

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

### Patch Changes

- 76d25d4: Stop re-exporting test-only conformance suite from runtime barrel; this previously pulled `vitest` into the production bundle and crashed the deployed server with ERR_MODULE_NOT_FOUND.
- a3d3835: Force all libraries and the server to publish/deploy after the 1.0.1
  release failure. Restores the `@alexkroman1/` scope on publishable
  packages so npm accepts the publish, and bumps `aai-server` to trigger
  the Fly.io deploy job in the release workflow.

## 1.0.1

### Patch Changes

- 5517333: Simplify codebase: fix SSRF bypass in sandbox builtins, deduplicate utilities, strengthen types
- 5d55c12: Remove unnecessary comments that restate obvious code
- b4ff42e: Redeploy aai-server and refresh client/CLI/SDK releases

## 1.0.0

### Major Changes

- 837e34f: Remove self-hosted ./server API. Platform sandbox now uses Deno guest runtime with NDJSON transport.
- 7669733: Migrate aai-ui from Preact to React 19 with simplified API: useSession, useTheme, useToolResult hooks + two-tier defineClient

### Minor Changes

- 8ecb7d1: Add protocol compat fixtures and harden wire format for rolling upgrades
- befca9a: Simplify agent surface area: directory-based agent format with agent.json, tools/_.ts, hooks/_.ts replacing defineAgent/Zod
- ab98c61: Remove unused SDK features: `tool` alias, `ctx.fetch`, `onError` hook, `toolChoice: "none"` and `toolChoice: { type: "tool" }` variants. Add `ToolResultMap` typing to solo-rpg template.
- 14d0653: Remove kv.list() and kv.keys() from KV API — use explicit index keys instead
- 5fd5cb3: Zod-based agent.ts authoring with agent() and tool() helpers, rename aai-core to aai

### Patch Changes

- 3bd18a9: Fix security vulnerabilities: run_code sandbox escape, SSRF wiring, credential key enforcement, DNS rebinding, path traversal, harness auth bypass, timing-safe hash comparison
- 9211c65: Add default aai-ui client served by the server when no custom client is deployed. Remove zod externalization from the worker bundler — zod 4 works natively in Deno sandboxes. Update S2S API endpoint and fix load test event handling.
- b9b5c02: Deduplicate shared utilities, fix N+1 KV list, async static serving, and race timer leak
- 99db30d: Simplify protocol, security boundaries, and SDK structure
- 5cc9550: Security hardening: deploy ownership check, SSRF DNS fail-closed + hostname blocking, timing-safe auth tokens, run_code timer cleanup, WebSocket payload limits, message buffer cap, clientFiles size limits, HTML escape completeness, KV error sanitization
- 4c1cd20: Remove duplicate startSession patterns and dead resumeFrom plumbing
- f6e7a5c: BREAKING: Align SDK naming with S2S API

  - `instructions` → `systemPrompt` in AgentOptions/AgentDef
  - `DEFAULT_INSTRUCTIONS` → `DEFAULT_SYSTEM_PROMPT`
  - `onTurn` → `onUserTranscript` hook
  - Protocol events renamed: `transcript` → `user_transcript_delta`, `turn` → `user_transcript`, `chat` → `agent_transcript`, `chat_delta` → `agent_transcript_delta`, `tts_done` → `reply_done`, `tool_call_start` → `tool_call`

- 9d2141b: Simplify and refactor: eliminate duplicated code, fix leaky abstractions, improve hot-path efficiency
- 05f8759: Replace hand-rolled utilities with dependencies: dotenv for .env parsing, mime-types and escape-html in dev server, p-debounce for file watcher
- 1678546: Simplify codebase: use p-timeout for shutdown, html-to-text for HTML conversion, deduplicate secret key validation
- 64d83b6: Add Zod validation to NDJSON guest-to-host responses, fix session state memory leak
- 6d3ec72: Improve S2S load test concurrency: quiet mode, staggered ramp-up, zero-copy audio buffers

## 0.12.3

### Patch Changes

- 4ebd7b6: Standardize file and directory naming to idiomatic kebab-case conventions

  - Add ls-lint for file naming enforcement
  - Drop underscore prefix from internal files in aai-server (e.g. `_schemas.ts` → `schemas.ts`)
  - Rename `_components` → `components` and `__fixtures__` → `fixtures` in aai-ui
  - Rename `__fixtures__` → `fixtures` in aai/host
  - Flatten aai-server by removing `src/` directory

- 68f4d84: Make more cross platform

## 0.12.2

## 0.12.1

### Patch Changes

- f4762a1: Externalize zod from agent bundles, remove storage cache, improve CI reliability

## 0.12.0

### Minor Changes

- 99e62c3: Remove `memoryTools()` and the `"memory"` builtin tool. Users who need KV-backed memory tools should define them directly in their agent's `tools` record.

## 0.11.1

### Patch Changes

- c25ee7e: Trigger deploy for SDK and server

## 0.11.0

### Patch Changes

- 491ec37: CLI overhaul: remove generate command, unify output style, template descriptions

  - Remove `generate` and `run` commands and AI SDK dependencies
  - Unify CLI output to use @clack/prompts style consistently
  - Add template descriptions shown as hints in `aai init` select prompt
  - Fix deploy slug mismatch between bundle and deploy steps
  - Clean deploy error messages (no stack traces)
  - Add `@alexkroman1/aai-cli` to scaffold devDependencies
  - Remove fly.toml from scaffold
  - Use cyanBright for all URLs in CLI output
  - Remove eventsource-parser patch
  - Add link-workspace-packages to .npmrc
  - Fix Dockerfile: run esbuild install script, remove patches references

## 0.10.4

### Patch Changes

- 6f6a43e: Harden platform security and refactor to @hono/zod-validator

  - Fix crash in sandbox-network when host.internal hit without handler
  - Add Zod validation to KV bridge (isolate→host) replacing raw JSON.parse
  - Refactor deploy, secret, and KV handlers to use @hono/zod-validator middleware
  - Fix type errors in \_harness-runtime.ts and sandbox.ts
  - Remove factory.ts, inline into orchestrator
  - Add 185 new security tests for cross-agent isolation, SSRF, and trust boundaries

## 0.10.3

### Patch Changes

- 8d5f616: Use Hono builtins for WebSocket, security headers, and HTML escaping

  - Replace manual WebSocketServer + upgrade handling with @hono/node-ws
  - Replace custom escapeHtml() with Hono's html tagged template
  - Replace manual CSP string with secureHeaders middleware
  - Fix aai rag to use local dev server in dev mode
  - Fix vector upsert model loading in local dev mode
  - Add missing aws4fetch dependency for unstorage S3 driver

## 0.10.2

### Patch Changes

- 9de059e: Add repository.url for npm provenance, fix circular dependency, bump CI actions
- 1397f37: Fix Fly deploy config path and CI improvements

## 0.10.1

### Patch Changes

- aa23a1c: Add repository.url for npm provenance, fix circular dependency, bump CI actions

## 0.10.0

### Minor Changes

- Replace LanceDB with sqlite-vec for vector storage, add `generate` CLI command, extract templates to giget, local dev mode improvements, auth cleanup, and graceful shutdown fixes

## 0.9.4

### Patch Changes

- Release all packages with version increment

## 0.9.3

## 0.9.2

## 0.9.1

### Patch Changes

- Update

## 0.9.0

### Minor Changes

- Updated toolchain
