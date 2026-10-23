# @alexkroman1/aai

## 0.17.0

### Minor Changes

- b1d73be: Shrink the shapes on the SDK's contracted surface that keep producing breaking
  changes. Breaking:
  
  - **Every exported object type carries a direction**: options, config and
    declarations are `@input`; contexts, results, handles and testing records are
    `@sealed`.
  - **Toolsets are plumbing**: `Toolset`, `ToolsetEntry`, `ToolExecutor` and
    `ToolSource` moved to `@alexkroman1/aai/manifest`, and `AgentDef.toolsets` is
    gone from the public type (`ResolvedAgentDef` on `/manifest` carries it).
    `ToolBearingAgent` no longer names `toolsets`.
  - **Implementation budgets moved to `/internal`** (or `/host-internal`):
    `TRANSCRIBE_SYNC_ENDPOINT`, `TRANSCRIBE_*_TIMEOUT_MS`,
    `TRANSCRIBE_WINDOW_BYTES`, `STEP_SPEAK_TIMEOUT_MS`, `DEFAULT_CALL_*`,
    `DEFAULT_CLIENT_ACK_TIMEOUT_MS`, `DEFAULT_CLIENT_RETRY_MS`,
    `CHANNEL_POST_TIMEOUT_MS`, `DEEPGRAM_DEFAULT_ENDPOINTING_MS`,
    `MCP_TOOL_NAME_MAX`, and the coding tools' `BASH_TIMEOUT_*`, `GLOB_LIMIT`,
    `READ_LIMIT`, `CODING_TOOL_DESCRIPTIONS`. Constants that stay public are typed
    as their primitive.
  - **The session event vocabulary is declared, not inferred from zod**:
    `SessionEventMap` is written out; `SessionEventSchema` moved to
    `@alexkroman1/aai/protocol`, typed `z.ZodType<SessionEvent>`. A `"*"` handler
    receives the open `AnySessionEvent` envelope. `SessionErrorCode`,
    `AgentTranscriptRecovery` and an event's `stage`/`limit`/`direction` are open
    (`| (string & {})`). `EventMapOf` and `SessionEventTypeList` are removed;
    `SESSION_SOURCED_EVENT_TYPES` moved to `/internal`. `SessionEventMeta`,
    `RestoredToolCall` and `ClientConfigResponse` are declared types, and their
    schemas are typed `z.ZodType<T>`.
  - **Catalogs are plain arrays**: `ASSEMBLYAI_TTS_VOICES` is
    `readonly AssemblyAITtsVoice[]`, `TRANSCRIBE_MODELS` is `readonly string[]`.
  - **Closed unions an author receives are open**: `PlacedCallStatus`,
    `ToolRefusalReason`, `Message.role`, `ClientUnreachableReason`,
    `SpeechOutcome`, `ClientRunStatus`, `FfmpegFailureKind`,
    `ClientTranscriptMessage.role`, `StubTranscribeLeg`, `FetchRouteHit.outcome`
    and `.via`.
  - **`dialog()` no longer names XState types**: `Dialog<E>` is generic over its
    events only, `Dialog.machine` is `unknown`, and the machine overload takes the
    SDK-owned structural `DialogMachine`.
  - **`SlotStore.write(key, value, { durable })`** replaces the positional boolean
    (durable by default); `createSlotStore()` joins `/testing`.
  - **`MetricsSample` is its own `@input` interface** rather than an `Omit` of the
    event; `MetricsCollector.collect` takes the event or a sample.
  - **`routeResponse(status, body, { headers })`** can set response headers.
  - `RunSnapshotOverrides` is derived from `WorkflowRunSnapshot`;
    `ValidatedRouteRequest` is `RouteRequest<Body>`;
    `AssemblyAISttOptions.languages` is `readonly string[]`.
  - The `testing` and `agent` capabilities were split for size (`testing-steps`,
    `testing-network`, `testing-workflow`, `testing-client`, `testing-deploy`;
    `agent-routes`, `agent-mcp`, `agent-session`); the subpaths are unchanged.

### Patch Changes

- a8a37ac: Tag `PlaceCallOptions` `@input`: an author builds it and the SDK only reads it,
  so the API contract gate now treats a member becoming optional, or a union in it
  widening, as compatible. No signature changes.
- 8f93cca: Fix SDK response error propagation, partial file writes, stream cancellation,
  synchronous slot updates, callable schema conversion, fallback provider
  validation, and ownership claim isolation.
  
  Prevent canceled browser sessions from requesting microphone access after lazy
  audio loading completes.

## 0.16.0

### Minor Changes

- 06d09d5: AssemblyAI streaming TTS now follows the documented API
  (https://www.assemblyai.com/docs/tts): it dials
  wss://tts.us.assemblyai.com/v1/ws (or tts.eu.assemblyai.com, which
  assemblyAIPipeline({ region: "eu" }) now selects), sends voice_id instead of the
  retired voice param, and splits Generate text at the 2000-character per-frame
  cap, so a long stepSpeak no longer fails. Breaking: voices are voice_id slugs —
  assemblyAITts({ voice: "aai-jane" }), not "jane" — and ASSEMBLYAI_TTS_VOICES is
  now a tuple of the 11 library slugs, every one of which speaks all six
  languages; ttsVoiceIds, ttsVoiceInfo and AssemblyAITtsVoiceInfo are removed (use
  z.enum(ASSEMBLYAI_TTS_VOICES)), as is the voice/language mismatch check.

## 0.15.5

No changes in this release.

## 0.15.4

No changes in this release.

## 0.15.3

### Patch Changes

- 4a291dd: Studio packages reuse shared SDK helpers (runCapped, LogLine/formatLogTime,
  estimateMessageTokens, walkWorkspaceFiles, ai UI-message helpers) instead of
  hand-rolled copies; the studio adopt fetch now aborts on timeout.

## 0.15.2

No changes in this release.

## 0.15.1

No changes in this release.

## 0.15.0

### Minor Changes

- 851a4ab: Outbound calls connect on the managed platform: `stepPlaceCall` now dials Twilio
  with a webhook (`<agentUrl>/phone?…`) instead of inline TwiML, the platform's
  `/:slug/phone` and a self-hosted server's new HTTP `/phone` pass the call's
  parameters into the stream, and `agentUrl` defaults to the agent's own public
  URL. `stubPlaceCall` records `webhookUrl` (was `streamUrl`) and takes
  `publicUrl`. `outbound-call-agent` no longer needs `CALLER_AGENT_URL`.

## 0.14.4

### Patch Changes

- d266c27: Route `agent({ routes })` on the managed platform: `/:slug/api/*` now forwards
  to the agent's sandbox (per-IP rate limited), so a deployed page's
  `fetch("api/…")` no longer 404s.

## 0.14.3

### Patch Changes

- d648b81: Agents can press phone keys: `sendDtmf(ctx, keys)` (on
  `@alexkroman1/aai/experimental`) plays DTMF tones into the session's audio,
  which a `WS /phone` call carries to the carrier in-band, so an agent can answer
  an automated phone menu ("press 1 for…") or enter an extension.
  `sentDtmfCalls(ctx)` reads back what a `createToolContext` tool pressed. The
  outbound-call-agent template gains a `press_keys` tool and prompt guidance for
  phone menus.

## 0.14.2

### Patch Changes

- d66b0c3: Rewrite hand-rolled state machines as XState statecharts: the AssemblyAI TTS
  cancel/reconnect lifecycle, the platform socket reconnect loop, the pipeline
  session lifecycle and push-to-talk turn, the browser session connection
  lifecycle, the workflow form submission, and the `aai dev` restart supervisor.
  Share one backoff reconnect loop (`createBackoffLoop` in `/internal`) between
  the inbox and studio event stream.

## 0.14.1

No changes in this release.

## 0.14.0

### Minor Changes

- 99400e3: BREAKING (testing API): fold routeStepFetch, StepRoute and StepUnmatched into
  stubFetchRoutes — pass it the list of legs (a model's stubGatewayRoute().route
  first), with the new globalFetch: false option to route only the step fetch.
  Remove installFetchRoutes (use stubFetchRoutes plus onTestFinished(net.restore))
  and createProgressStream (use ReadableStream.from). commandedBuiltins is no
  longer exported; expectPromptBuiltinsDeclared returns the same list.

### Patch Changes

- 5fa348b: Pay down debt-report ledgers: share the cause-chain walk, the runtime-file copy
  and the tool-message list normalizer; drop four `as never` casts behind typed
  seams
- f6aa687: `defineAgentTestConfig()` now sets `restoreMocks`, `unstubEnvs` and
  `unstubGlobals`, so a scaffolded project's specs no longer leak a `vi.spyOn`,
  `vi.stubEnv` or `vi.stubGlobal` into the next test. Pass
  `test: { unstubGlobals: false }` (or any of the three) to opt out.
- 67f7354: `ProjectFiles.tools` (on `@alexkroman1/aai/testing`) spells out its type,
  `Readonly<Record<string, unknown>>`, instead of naming `ToolModules`, a type no
  testing capability owned. The type is the same, so nothing that compiled before
  stops compiling.
- 8820f2c: Replace truthiness-guarded conditional spreads with explicit presence checks
  (omitUndefined, != null, === true), so an empty-string body forwarded to a guest
  is no longer dropped; guard-invariants rule 22 is now enforced at zero.
- f869b6a: Use the shared isRecord guard in standard-schema issue paths and the eval
  partial matcher
- 5fa348b: Give every module a co-located test and remove every vi.mock: collaborators the
  specs used to mock by module are now optional injected seams that default to the
  real implementation
- 5ded42b: Test-only: the procedure spec's actor honours its abort signal; no runtime
  change.
- 99400e3: Internal: the /testing fakes share one scripted gateway, script router, schema
  check, step-fetch recorder and recording slot. No signature or behaviour change.

## 0.13.0

### Minor Changes

- The first `0.x` release. Versions 1.0.0 through 18.0.0 were pre-release history and are not carried forward; this line restarts at 0.13.0, the lowest `0.x` not already on the registry. During `0.x` a breaking change is a minor bump.
- Every deprecated API is removed: `createRuntimeServer` (use `createServerForRuntime`), `AgentInstructions` (`Exclude<AgentSystemPrompt, string>`), `StaticAgentParams` (`WorkflowAppAgentParams`), `scriptedToolContext` and its two types (`createToolContext` takes the `generate`/`delegate` scripts and exposes `ctx.model`/`ctx.desk`), `SessionSlot.projection(view)` (declare `sessionSlot(key, create, { view })` and pass `slot.projected`), the record form of `agent({ syncState })` (pass a projection or a list), and `aai test --all` (now a usage error).
- Every legacy fallback is removed: `session.configured.sessionId` is required and `?resume=1` is gone, the platform base URL is read only from `AAI_PLATFORM_BASE_URL`, and a configuration with no stages is S2S only with an explicit `s2s` descriptor.
- Every API contract epoch restarts at 1.
