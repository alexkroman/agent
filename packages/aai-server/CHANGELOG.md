# aai-server

## 0.2.11

### Patch Changes

- Updated dependencies [502507c]
  - @alexkroman1/aai-runtime@0.18.2
  - aai-guest@0.6.25
  - @alexkroman1/aai@0.18.2

## 0.2.10

### Patch Changes

- Updated dependencies [dea550d]
  - @alexkroman1/aai-runtime@0.18.1
  - aai-guest@0.6.24
  - @alexkroman1/aai@0.18.1

## 0.2.9

### Patch Changes

- f1a994b: Simplify the agent authoring surface, and move every template onto it.
  
  Slots and dialogs: `slot.tool`/`slot.updateTool` take the dialog gate (`dialog`,
  `when`, `send`, `sendFrom`, `reset`) plus `require`, `prepare` and `report`;
  `slot.transact`; `after` runs on every store; `sessionSlot` accepts a plain
  default and `sync: true`, `empty`; `SlotValueOf`/`SlotDraftOf`; `when` is
  optional on `dialog.tool`; `sendFrom` has a field form and a second-argument
  form; `DialogStateSpec.onEnter`; `inputSchema` may be omitted or `undefined`.
  
  Agent definition: `listing` (the registry line; `description` is a deprecated
  alias), `promptContext` appended under `system-prompt.md`, `tool({ ui })`,
  `withInstruction`/`instructionOf`, `ctx.turn`/`ctx.now()`,
  `AgentSessionContext.turn`, `SessionEndContext.transcript`/`slots`,
  `apiKeyRoute`, call briefs on `stepPlaceCall` (`readCallBrief`), `agent()` and
  `workflowApp()` generic over their `workflows` map.
  
  Workflows: `workflows/<name>.ts` is discovered;
  `ctx.poll({ first, slowAfterMs })`, `ctx.report`, `ctx.key`,
  `ctx.waitForSignal`/`signalToken`, `workflows.signalRun`/`latest`/`live`, held
  signals, the `workflow_status`/ `workflow_progress`/`workflow_cancel` builtins
  with `describeRun`/`cancelNote`, `WorkflowInputOf<typeof schema>` and the
  two-phase `workflow({...}).body()`, `StepOptions.maxWaits`, run
  `startedAt`/`settledAt`, `transcribeUploadDurably`, `transcodeUpload`,
  `stepSpeakToUpload`, `fatalOn`/`orFatal`, `stepWebhookUrl({ optional })`,
  `UploadInfo.label`, `workflowApp()` defaulting `requiredEnv`.
  
  Client: `theme: { primary, mode }`, `mountClient({ css })`, tool icons from the
  def, `SessionStateDot` from the theme, hooks typed by the app def
  (`useWorkflowSubmit<typeof agentDef>("name")`), `submission.timing`/`scope`,
  `<WorkflowFields>` rendering `string[]` and `{ name, text }`, `routeFetch`
  headers, `useRoute` polling.
  
  Testing: typed `run(toolDef)`, `toolResultIn(calls, toolDef)`,
  `lastStateIn(events, slot.projected)`, `expectSlotContract`, `describeAgent`,
  `sessionEvent`/`fireEvent`, `installStubWorld`, `installStubGateway` seeding the
  key, `describeEval({ steps })`, `evalRunOf`, `runWorkflow(agentDef, name, …)`,
  `createRouteContext`.
  
  Breaks while on 0.x: `ToolRunner` is an overloaded interface, `ToolDef`'s schema
  parameter admits `undefined`, `WorkflowInputOf` reads a schema or a declaration,
  `stepTranscribeUpload` resolves `{ audioUrl, source, size }`,
  `eventsOf`/`isEvent` moved to the `testing-events` capability and the
  `WorkflowInputOf` family to `workflow-readings`,
  `RouteContext.sessionTranscript` is required, `installStubWorld` returns `files`
  and takes `uploads` as one object.
  
  Hardening from an adversarial pass over the new surface: a returned
  `ToolFailure` from an `updateTool` body, `report` or `transact` stores nothing;
  `reset: true` runs after `require`/`prepare` and its `send` is honoured;
  function-form `sendFrom` narrows on slot tools and `sendFrom: "field"` naming a
  non-event field is a compile error; nested `$instruction` keys are lifted;
  plain-value slot defaults are checked at declaration; `workflowApp()` takes no
  `workflows`, a def with none refuses every typed hook name, `isWorkflowDef`
  requires a `workflow()`-made def, nested `workflows/**` defs are refused and a
  def declared under a name is not re-registered under its file; `sync: true`
  projections are claimed by every agent form; signal holds need a live run,
  `maxWaits` counts only a NAMED delay, the builtins see live runs first, the text
  agent scopes `ctx.workflows` by session; `TranscribeDurablyOptions`/
  `PollOptions.maxWaits`; a missing upload or key is fatal; call briefs survive
  TwiML whitespace and surrogate pairs, `readCallBrief` refuses a multi-line id
  and trims the secret, `x-api-key` reaches a deployed route; `onSessionEnd` fires
  once; `useRoute` resets on a path change and refuses a negative `pollMs`;
  `routeFetch` headers are case-folded; an empty run `key` is refused on both
  ends; `<WorkflowFields>` reads nullable enums, literal unions and numeric
  selects; the theme forms are exclusive; `installStubGateway({ apiKey: false })`
  clears the env; `fireEvent` refuses an empty `events` map.
  
  The old forms each of these replaced are REMOVED, not deprecated: `agent()`
  takes no `description` (write `listing`), no `systemPrompt` (write
  `system-prompt.md` beside `agent.ts`, plus `promptContext` for computed text; a
  host sets a prompt on the lowered def with `withSystemPrompt`) and no
  `syncState` (declare the slot `sync: true`); `mountClient` takes no `name` or
  `tools` (both come from the agent's own client config); `runWorkflow`'s options
  carry no `name` (the agent form names the run); and every testing helper reaches
  a tool by its DEF, never a name string — `run`, `runTool`,
  `toolResultIn`/`lastToolResultIn`/`toolResultsIn`/`toolArgsIn`,
  `parseToolInput`/`toolInputIssues` (no agent argument either), `turnCalling`,
  `expectCalled`, and the claimed `expectToolOk<T>`/`expectDialogOk<T>` overloads.
  A roster tool is reached through its speaker's `tools` map, a builtin through
  `builtinTool("workflow_cancel")` on `@alexkroman1/aai/tools`. Epochs:
  `aai:agent` 2, `aai:testing` 2, `aai-runtime:testing` 2,
  `aai-runtime:eval-assert` 2, `aai-ui:client` 2, each with the previous epoch
  dropped.
- 21ec93b: Studio: rotating the account API key releases the old key's owner mapping, so
  its holder's CLI no longer lands in the rotating account's scope; DELETE …/file
  deletes an empty file and 404s a name only the file map's prototype holds
- f40ff5e: Harden the platform against hostile tenants: a re-claimed slug no longer repeats
  a deleted deploy's version (and so its guest bearer), owner secret/delete routes
  re-check ownership under the slug lock, failed authentications on owner routes
  are rate-limited per IP, a session token verified past its exp is no longer
  cached forever, buffered guest responses are size-capped, the platform socket's
  dispatch URL ignores a forged Host path, and session-state readEvents pages are
  capped.
- fccf609: Bound three guest resource bypasses found by adversarial testing: the coding
  tools' `grep` runs a model-supplied regex in a terminable worker (a catastrophic
  pattern no longer wedges the whole process), `run_code` caps the console output
  it keeps, and the studio's `download_to_workspace` stops reading a response at
  the file cap instead of buffering it whole.
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [ac38a37]
- Updated dependencies [1f6553d]
- Updated dependencies [f1a994b]
- Updated dependencies [1f6553d]
- Updated dependencies [f1a994b]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [5a7e065]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [6a967bc]
- Updated dependencies [5a7e065]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [e7cc510]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1d6304d]
- Updated dependencies [90f9990]
- Updated dependencies [1f6553d]
- Updated dependencies [fccf609]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [af9fb16]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
  - @alexkroman1/aai-runtime@0.18.0
  - @alexkroman1/aai@0.18.0
  - aai-guest@0.6.23

## 0.2.8

### Patch Changes

- eb14ffe: Reshape `@alexkroman1/aai-runtime`'s published surface so it stops producing
  breaking changes. Breaking (0.x minor):
  
  - `RuntimeOptions.journal`, `AgentServerOptions.journal` and
    `RunWorkflowOptions.journal` take an opaque `WorkflowJournal`; build one with
    the new `createMemoryJournal()`. `JournalStore`, its records,
    `JournalConflictError` and `DeterminismKind` are no longer published. A
    `runWorkflow` handle now reports its journaled waits (`waits`) and whether a
    boot sweep would pick it up (`resumable`).
  - `CarrierCodec` implements one `encode(out: CarrierOutbound)` (answer
    `undefined` for a kind it has no frame for) in place of `media`/`clear`.
    `CarrierInbound`'s `ignore` became `other { type }`, and a key press decodes
    as `dtmf { digit }`.
  - `TextTurnResult` is a declared slice (`textStream`, `text`, `response`,
    `consumeStream`) instead of the whole AI SDK `streamText` result, and
    `TextAgentTestRun.steps` is gone.
  - `SessionEventStream` is a sealed reader (`tail`, `read`, `durable`).
  - `createToolCallRepair` takes one `ToolCallRepairOptions` bag.
  - `SimulatedCall.endedBy`, `PhoneTreeWalk.stopped`, `EvalRequest.outcome`,
    `WorkflowTestStep.status` and `SttError`/`TtsError.code` are open string
    unions.
  - Removed: the `keys` capability (`createMemoryKeyStore`,
    `createPostgresKeyStore`, `resolveKeyStore`, `WorkflowKeyStore`),
    `WORKFLOW_API_PREFIX`, `ExecuteTool`, `ExecuteToolOptions`,
    `SkipGreetingOption`, `S2sConfig`, `McpCallResult`, `McpInputSchema`,
    `McpTrust`, `UploadMeta`, `UploadPart`, `HostGenerateFn`, `StepUsage`,
    `StepFetch` and `EvalWorkflowEngineOptions`.
  
  `Db` and `RunCodeExecutor` are now declared by this package, options and result
  types carry `@input`/`@sealed`, and the eval readers and the
  `EvalTurn`/`EvalToolCall` records moved to the `eval-assert` capability. The
  studio's coding agent takes the full AI SDK turn from the internal
  `createHostTextAgent`.
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
- Updated dependencies [a8a37ac]
- Updated dependencies [eb14ffe]
- Updated dependencies [b1d73be]
- Updated dependencies [8f93cca]
- Updated dependencies [130bc0c]
  - @alexkroman1/aai@0.17.0
  - @alexkroman1/aai-runtime@0.17.0
  - aai-guest@0.6.22

## 0.2.7

### Patch Changes

- f5ca0c1: Keep deployed agents reachable through a platform deploy: a shutting-down
  replica hands its agent guests off to the fleet instead of draining them (a
  draining guest held its sandbox name and refused every new session for up to ten
  minutes), and a guest sandbox now stops the moment its harness exits, releasing
  its name.
- Updated dependencies [06d09d5]
  - @alexkroman1/aai@0.16.0
  - aai-guest@0.6.21
  - @alexkroman1/aai-runtime@0.16.0

## 0.2.6

### Patch Changes

- b2e8001: The studio coding agent eval gains a multi-turn case: a follow-up must change
  the tool the first turn built.
- 265e845: The studio coding agent eval names its shipped-prompt copy at
  packages/aai-guest-studio/studio-prompts/, where it moved.
- aai-guest@0.6.20
  - @alexkroman1/aai@0.15.5
  - @alexkroman1/aai-runtime@0.15.5

## 0.2.5

### Patch Changes

- aai-guest@0.6.19
  - @alexkroman1/aai@0.15.4
  - @alexkroman1/aai-runtime@0.15.4

## 0.2.4

### Patch Changes

- 4a291dd: Studio packages reuse shared SDK helpers (runCapped, LogLine/formatLogTime,
  estimateMessageTokens, walkWorkspaceFiles, ai UI-message helpers) instead of
  hand-rolled copies; the studio adopt fetch now aborts on timeout.
- Updated dependencies [4a291dd]
  - @alexkroman1/aai@0.15.3
  - aai-guest@0.6.18
  - @alexkroman1/aai-runtime@0.15.3

## 0.2.3

### Patch Changes

- aai-guest@0.6.17
  - @alexkroman1/aai@0.15.2
  - @alexkroman1/aai-runtime@0.15.2

## 0.2.2

### Patch Changes

- a03cdca: Slim the studio to voice agents only: remove the Voice agent / Workflow project
  kind (one system prompt, one starter list), the API, Workflows and Logs panes,
  the public /studio/api/<slug> page, and the Secrets pane's .env paste box. The
  Twilio and Telnyx webhook URLs move to the Settings pane.
- Updated dependencies [89737d1]
- Updated dependencies [9ed592e]
  - @alexkroman1/aai-runtime@0.15.1
  - aai-guest@0.6.16
  - @alexkroman1/aai@0.15.1

## 0.2.1

### Patch Changes

- 1949e58: Outbound calls pass Twilio signature verification: Modal's proxy unquotes the
  webhook query before it reaches `/:slug/phone`, so the platform now also
  verifies against the query re-encoded the way `stepPlaceCall` built it.

## 0.2.0

### Minor Changes

- 851a4ab: Outbound calls connect on the managed platform: `stepPlaceCall` now dials Twilio
  with a webhook (`<agentUrl>/phone?…`) instead of inline TwiML, the platform's
  `/:slug/phone` and a self-hosted server's new HTTP `/phone` pass the call's
  parameters into the stream, and `agentUrl` defaults to the agent's own public
  URL. `stubPlaceCall` records `webhookUrl` (was `streamUrl`) and takes
  `publicUrl`. `outbound-call-agent` no longer needs `CALLER_AGENT_URL`.

### Patch Changes

- Updated dependencies [851a4ab]
  - @alexkroman1/aai@0.15.0
  - aai-guest@0.6.15
  - @alexkroman1/aai-runtime@0.15.0

## 0.1.5

### Patch Changes

- d266c27: Route `agent({ routes })` on the managed platform: `/:slug/api/*` now forwards
  to the agent's sandbox (per-IP rate limited), so a deployed page's
  `fetch("api/…")` no longer 404s.
- Updated dependencies [d266c27]
  - @alexkroman1/aai@0.14.4
  - aai-guest@0.6.14
  - @alexkroman1/aai-runtime@0.14.4

## 0.1.4

### Patch Changes

- Updated dependencies [d648b81]
  - @alexkroman1/aai@0.14.3
  - aai-guest@0.6.13
  - @alexkroman1/aai-runtime@0.14.3

## 0.1.3

### Patch Changes

- d66b0c3: Name the agent sandbox slot states as a discriminated union; validate a reloaded
  guest bundle before swapping it in (a failed reload keeps the old agent
  serving); studio turn step policy as a pure reducer; studio auth as an XState
  machine.
- Updated dependencies [d66b0c3]
- Updated dependencies [f7c51dc]
  - @alexkroman1/aai@0.14.2
  - @alexkroman1/aai-runtime@0.14.2
  - aai-guest@0.6.12

## 0.1.2

### Patch Changes

- aai-guest@0.6.11
  - @alexkroman1/aai@0.14.1
  - @alexkroman1/aai-runtime@0.14.1

## 0.1.1

### Patch Changes

- 5fa348b: Pay down debt-report ledgers: share the cause-chain walk, the runtime-file copy
  and the tool-message list normalizer; drop four `as never` casts behind typed
  seams
- 016e6ee: Slow test tiers are vitest projects selected with --project; no runtime change.
- 8820f2c: Replace truthiness-guarded conditional spreads with explicit presence checks
  (omitUndefined, != null, === true), so an empty-string body forwarded to a guest
  is no longer dropped; guard-invariants rule 22 is now enforced at zero.
- 66953d5: An MCP connect that times out now aborts its in-flight fetches instead of
  leaving them to the SDK's own request timeout. The orchestrator exposes
  `stopSweeps` so a test-built one stops its queue sweep.
- 5fa348b: Give every module a co-located test and remove every vi.mock: collaborators the
  specs used to mock by module are now optional injected seams that default to the
  real implementation
- a9267f2: Model-provider fetch wrappers now take their delegate as a required argument,
  named once by the LLM registry (still the ambient fetch, read per call); agent
  boot artifacts in a contained guest are written under the guest scratch dir
  (/var/tmp) instead of a hardcoded /tmp.
- 3969f74: memoAsync: a build rejecting after reset() no longer evicts the successor build,
  so the next caller joins it instead of starting a redundant third build
- 2dcbe80: Refuse an over-size secret update with a 413 before anything is written: the 64
  KiB env cap is now checked on the merged project record and on every agent's
  merged env, so a refused PUT no longer leaves the value in the project record.
  The per-slug secret PUT and a deploy with an oversized env answer 413 instead of
  500, and a project record already over the cap is applied name-by-name at deploy
  with a warning instead of failing silently.
- Updated dependencies [5fa348b]
- Updated dependencies [f6aa687]
- Updated dependencies [3c0d0dd]
- Updated dependencies [67f7354]
- Updated dependencies [8820f2c]
- Updated dependencies [f869b6a]
- Updated dependencies [b77171d]
- Updated dependencies [66953d5]
- Updated dependencies [dd2e1db]
- Updated dependencies [99400e3]
- Updated dependencies [5fa348b]
- Updated dependencies [5ded42b]
- Updated dependencies [a9267f2]
- Updated dependencies [99400e3]
  - @alexkroman1/aai@0.14.0
  - @alexkroman1/aai-runtime@0.14.0
  - aai-guest@0.6.10

## 0.1.0

History before the `0.x` reset lives in git.
