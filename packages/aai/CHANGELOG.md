# @alexkroman1/aai

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
- 2898f21: Pipeline voice UX: stream interim user transcripts to the client (user_transcript_partial) with speech_started/speech_stopped edges, resume replies after false interruptions (falseInterruptionTimeoutMs), and expose pipeline tuning knobs on agent() — minBargeInWords, interruptionMinDurationMs, endpointSettleMs, completeSettleMs, holdPhrase. LiveKit-parity default changes: completeSettleMs default 600→500 ms, Deepgram endpointing default 300→100 ms (now configurable via deepgram({ endpointing })).
- 882e7d9: Host mode now inherits the deployed agent's `stt`/`llm`/`tts` provider config, so a `?host=1` session runs the operator's configured pipeline (e.g. AssemblyAI Universal-3.5 Pro STT + LLM + TTS, with agent_context/voice_focus) with only the client's system prompt, greeting, and tools injected — instead of falling back to the default S2S path. The dev server passes its loaded agent as `hostBaseAgent`.
- e2ee4fd: Add voice-agent host mode: external clients can inject system prompt + tool schemas via config.host and receive tool calls to execute (tool_result), enabling harness-driven agents.
- 0d024e0: Add `gateway()` LLM provider factory routing through the Vercel AI Gateway, so pipeline agents can use any `"creator/model"` id (e.g. `zai/glm-4.6`) with a single `AI_GATEWAY_API_KEY`.
- ab38293: Add AssemblyAI LLM Gateway provider for pipeline mode: assemblyAI({ model, region? }) in @alexkroman1/aai/llm routes the LLM loop through the OpenAI-compatible gateway (25+ models) using ASSEMBLYAI_API_KEY
- fd5a54e: Update all dependencies to latest: Vercel AI SDK v7 (@ai-sdk/\* v4), Cartesia SDK 3.3, Deepgram 5.5, ElevenLabs 2.58, AssemblyAI 4.36; Pinecone peer range is now ^8.0.0. Tooling: Biome 2.5, TypeScript 7, Vite 8.1, Vitest 4.1.10, tsdown 0.22.
- a413caf: Concurrency hardening in the agentic loop: tool calls now receive a history snapshot and a turn-scoped AbortSignal (exposed as ctx.signal) that cancels on barge-in, reset, or session stop; duplicate reply.done frames mid multi-hop turn no longer end the reply early; a failed S2S resume emits a single connection error and cannot loop into repeated resume attempts; host-mode relay refuses duplicate in-flight toolCallIds and honors turn aborts; ws-handler no longer marks a session ready (or drains buffered frames) after the socket closed mid-start.
- 0235618: Enable AssemblyAI voice focus (noise suppression) by default: the streaming STT provider now sends `voice_focus: "near-field"` at connect. Configurable via the `voiceFocus` option (`"near-field"` | `"far-field"` | `"off"`); set `"off"` to disable.
- 115a88e: Voice benchmark reliability: preserve completed tool calls/results in LLM history across barge-in aborts (no more repeated or forgotten tool calls after an interruption), settle clearly-complete STT finals briefly instead of committing instantly (plus a longer fragment settle window) so hesitant multi-part requests aggregate into one turn, coerce stringified scalar tool arguments to their schema-declared types, raise the default maxSteps to 10, and overhaul the default system prompt for act-first tool calling, full multi-part request completion, and argument fidelity.

### Patch Changes

- 4758dfc: Fix AssemblyAI streaming STT rejecting telephony audio with "Input Duration Violation". The provider now coalesces inbound PCM into 50–1000 ms frames (buffering ~100 ms, capping at 1000 ms, and flushing a ≥50 ms tail on close) before forwarding to AssemblyAI, which requires each streaming audio frame to fall in that window. Clients that stream standard 20 ms RTP frames (e.g. the tau2 harness) now work unchanged.
- 0f72bef: Refactor: split oversized source modules (session-core, runtime, pipeline-transport, deno guest harness) into focused sibling files. No behavior or public API change.
- bc62b75: Internal cleanup of the aai package: dedupe the header-WebSocket adapter and ToolSchema types across transports, extract a shared runReply scaffold in the pipeline transport, consolidate PCM16/base64/error-message helpers, replace per-audio-chunk idle-timer re-arming and per-chunk STT carry reallocation with cheap accumulators, serialize KV values once, move STT/TTS resolution onto registries, and remove dead API surface (S2sHandle.sendAudioRaw, Transport.updateSession, user_transcript.turnOrder).
- 7e67c24: Internal cleanup: shared safeJsonParse/LOG_PREVIEW_CHARS helpers, deduped s2s-transport connect and dev-server build paths, native base64 in the sandbox guest, single-source MAX_REQUEST_BODY_BYTES, and vendor-correct API-key fallback for pre-resolved STT/TTS openers. The aai dev server no longer prompts for an AssemblyAI API key when the agent uses no AssemblyAI provider.
- 8817f3f: Remove unused code and fallback paths: legacy host-guest RPC schemas, backward-compat aliases (`pendingKvRequests`, `handleKvResponse`), unused exports (`jsonLogger`, `touchSlot`, `S2sEvent`, `DEFAULT_THEME`, unused metric label types), legacy OpenAI Realtime beta event-name fallbacks, inert CLI flags (`--server`/`--yes` on commands that never read them), and over-exported internal types.
- 394867e: Fix a Cartesia TTS connect failure crashing the whole host process. `client.tts.websocket()` only returns the socket after connect resolves, so on a connect-time failure (e.g. the account is out of credits) the promise rejects before an `error` listener can be bound — and cartesia-js's `TTSEmitter._onError` does a bare `Promise.reject` (a fatal unhandled rejection) when the socket errors with no listener. The adapter now constructs `new TTSWS(client)` directly and binds the `error` listener before connecting, so the failure flows through the normal `tts_connect_failed` path and degrades only that session. As defense-in-depth, the `aai dev` host entry now installs a log-only `unhandledRejection` guard (mirroring aai-server).
- 8004ff8: Fix Cartesia TTS killing the session with a fatal `tts_stream_error` on a benign barge-in race. When a `cancel`/`flush` crosses the context's `done` on the wire, Cartesia emits a per-context 400 "Invalid context ID" error frame on the shared socket; the handler now recognizes dead-context error frames (and frames tagged with a non-active `context_id`) and drops them, while still surfacing genuine socket failures.
- 0bdb115: Fix barge-in not stopping TTS playback after synthesis completes: pipeline mode now tracks estimated client-side playback and emits cancelled (flushing the client audio buffer) when the user speaks while buffered audio is still playing, even after the server-side turn has finished.
- 578a840: host: suppress duplicate tool_call frame in relay+pipeline mode (was double-executing relayed tools)
- a413caf: Pipeline/host latency: the greeting now starts as soon as the TTS provider connects instead of waiting for the slower STT connect; tool-call yields use setImmediate instead of setTimeout(0) (~2ms less overhead per call); the Vercel tool map is built once per session instead of per turn; provider sockets close in parallel on stop.
- 9750db7: Fix relayed tool calls failing with "invoked without a toolCallId" in host + pipeline mode. The sandbox/RPC `executeTool` wrapper dropped its 5th `callOpts` argument (which carries `toolCallId`), so the relay executor couldn't correlate the client's `tool_result` and rejected every call. The wrapper now forwards `callOpts` to the RPC executor. Latent until host mode began running the STT→LLM→TTS pipeline (S2S sourced the id from a different path).
- cb2821c: Fix 'unsupported reasoning metadata' warning in pipeline mode: replace smoothStream with a text-only word-coalescing transform so Anthropic thinking signatures on reasoning parts survive multi-step tool turns
- 9aed108: Fix uncaught exceptions that could crash the host process: shim assemblyai@4.36.3's discardPendingSocket so a timed-out streaming connect no longer emits an unhandled ws 'error' ("WebSocket was closed before the connection was established"), attach error handlers to HTTP upgrade sockets, and destroy unmatched upgrade sockets instead of leaving them dangling.
- 860bb7d: Refactor pipeline provider internals: extract a shared session shell for STT/TTS openers, define each provider's API-key env var once next to its kind tag, and make the LLM resolver table-driven. No behavior changes.
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
