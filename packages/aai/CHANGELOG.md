# @alexkroman1/aai

## 0.18.0

### Minor Changes

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
- 1f6553d: New pipeline defaults, measured on tau2-bench retail: `minTurnSilenceMs` 1600 →
  800, `interruption.continuationWindowMs` 2500 → 3500, and `assemblyAIStt` now
  sends `vad_threshold` 0.02 (`DEFAULT_VAD_THRESHOLD`; it sent nothing before, so
  the service's 0.2 applied). The 800 ms floor relies on continuation re-joining a
  turn split mid-sentence — an agent that sets `continuationWindowMs: 0` should
  also set `minTurnSilenceMs: 1600`. At 0.02 a caller voice the service gate had
  dropped entirely is heard; watch background-speech leakage in noisy rooms.
- 5a7e065: A tool can declare `effect: "handoff"` (`ToolEffect` is now
  `"read" | "write" | "handoff"`) to mark a transfer that ends the agent's part of
  the call. In a voice pipeline such a tool runs only when one of the caller's
  last two turns asks for a person (an English phrase list), or when the model
  calls it again after a further caller turn. Otherwise the model is told the
  transfer was NOT made and how to keep helping. Agents that declare no handoff
  are unchanged. The roster's `handoff` speaker switch carries no effect and is
  not gated. On tau2-bench retail, sims that transferred passed 17% of the time
  against 69% for those that did not, and 20 of 24 transfers were in failed sims.
  Replayed at those 24 transfers, the gate ran 9 of 12 samples at the expected
  transfers. Unwanted transfers fell from 22 of 60 to 9, all after the caller had
  asked for a person.
- e7cc510: Voice input for the studio composer via AssemblyAI's dictation API, with every
  piece available to framework users. The SDK adds `transcribeDictation()`,
  `handleDictationRequest()` (a web-standard `Request → Response` dictation route:
  body cap, call, `{ text } | { error }` reply) and the `DICTATION_*` limits on
  `@alexkroman1/aai/experimental`; `stepTranscribeSync` now builds on
  `transcribeDictation`. aai-ui adds `useDictation` (record one clip, hand it to
  your `transcribe` callback, get the words back; `buttonProps` and `disabled` for
  the mic button), `dictationTranscriber` (the matching `transcribe`) and
  `appendDictation`. The studio gains `POST /studio/dictation` on the caller's own
  key and a mic button in the chat composer.
- 1f6553d: The default AssemblyAI `min_turn_silence` (`DEFAULT_MIN_TURN_SILENCE_MS`,
  `turnTaking.minSilenceMs`) is now 250 ms instead of 800. On `universal-3-5-pro`
  it is the end-of-turn completeness CHECK, not a force-end, so it is the latency
  floor on every finished utterance. An unfinished sentence still stays open until
  `maxTurnSilenceMs` (3500, unchanged). On Full-Duplex-Bench v1.5 (498 scenarios),
  the median wait from the caller's last word to the commit fell 1.52 → 0.94 s
  (800 → 250), and interruption response latency 2.71 → 2.04 s, with no rise in
  split turns. Not yet re-measured on tau2-bench, where spelled names and dictated
  IDs are what the earlier, higher values protected; continuation re-joins such a
  split once the caller resumes. An agent that dictates identifiers, or that turns
  continuation off, should set its own value.
- 1f6553d: `turnTaking.preemptiveGeneration` now starts its speculative reply once an
  interim transcript's text has held still for `PREEMPTIVE_QUIET_MS` (300 ms). It
  used to wait for an interim at 0.9 end-of-turn confidence, but the default
  pipeline STT (`universal-3-5-pro`) reports 0 on every interim and 1 only on the
  final. So the flag did nothing: 0 adoptions in 1370 LLM turns of a
  Full-Duplex-Bench v1.5 run with it on. With the quiet window, adopted
  speculations started 0.8-2.1s before the final. The window restarts only when
  the normalized text changes. The adoption checks (exact final match, history,
  system prompt, no tool call) are unchanged, and the flag stays off by default.
  `PREEMPTIVE_CONFIDENCE_THRESHOLD` is removed from `host-internal`.
- 1f6553d: `assemblyAIStt({ vadThreshold })`: set the streaming service's voice-activity
  threshold (`vad_threshold`). Unset sends nothing, so the service default still
  applies. Lower it when a caller's speech goes unheard entirely — no
  `speech.started`, no transcript — rather than mis-heard.
- 1f6553d: Continuation: when the caller starts speaking again within
  `interruption.continuationWindowMs` (default 2500ms, `0` disables) of a
  committed turn, that speech is treated as the rest of the turn — the reply
  already answering the first fragment is cut, and the agent answers once the
  caller finishes. Covers callers who pause mid-sentence (reading out a ZIP,
  recalling an email) and were split into two turns, where the agent used to reply
  to half the sentence first. Respects `interruption: "off"` and a held floor,
  goes through false-interruption recovery so noise resumes the reply, and is
  capped at two per ten seconds so re-prompting cannot starve a reply.
- 1f6553d: An authored tool can now declare what it does to the world:
  `tool({ ..., effect: "write" })` (`ToolEffect` is `"read" | "write"`) marks a
  write, and the pipeline then runs it only on a caller turn that did not start
  while the agent was talking. The field is carried from `ToolDef` to the wire
  `ToolSchema.effect` (through `tool()` and session-slot tools alike). The SDK's
  own coding tools `write_file`, `edit_file` and `delete_file` are marked.
- 1f6553d: Two pipeline safeguards for tool-using voice agents.
  
  A tool schema may declare `effect: "write"` to mark it as a write. The pipeline
  then runs it only on a caller turn that did not begin while agent audio was
  playing (filler included); otherwise the model is told to ask for confirmation
  and wait. On tau2 retail, three writes ran on a backchannel spoken over the
  agent's question. Tools without it are unchanged.
  
  The proper nouns in tool results (names, products, cities) are now pushed to the
  STT as keyterms for the rest of the call, through a new optional
  `SttSession.updateKeyterms`, which AssemblyAI implements with `keyterms_prompt`.
  On tau2 retail, "pet bed" was transcribed "MedBed" and "Rossi" as "Rafi" after
  the agent had already looked both up.

### Patch Changes

- 1f6553d: The pipeline's opening dead-air filler is now timed from the caller's last word
  instead of from the commit. AssemblyAI STT reports how long ago the last word
  ended (`SttTurnMeta.trailingSilenceMs`), and the turn's first filler window is
  `DEAD_AIR_OPENING_TARGET_MS` (4.6 s) minus that wait, floored at 0. The target
  is derived: it is the latest point a filler is still heard before tau2's
  simulated caller re-prompts at 5.0 s, given the measured playout latency. On 62
  tau2 retail turns, replaying the fixed 2.4 s window against the anchored one
  gave fillers fired 25 → 22, fillers made redundant by the answer 11 → 9, and
  caller re-prompts first 7 → 3. Without word timings, or on a typed or chained
  turn, the fixed window applies as before.
- 1f6553d: System prompt: a yes covers the action exactly as agreed — when a tool rejects a
  value and the only way forward changes what the caller agreed to, ask again
  before writing, and never promise an outcome the tool hasn't confirmed; when two
  requests would each lock the same record, say so before doing either; and a
  reply ending in `[interrupted]` was only partly heard, so say again what the
  caller missed.
- 1f6553d: The default prompt now says how to make a "cheapest" or "most expensive" choice:
  across every available variant the record lists, holding fixed only what the
  caller said must stay, never an unavailable variant, and priced from the chosen
  variant's own field. On tau2 retail the model kept the current item's options (a
  shoe's size rule applied to every item; a lamp matching the old colour taken
  over the cheapest), which was 9 of the 13 writes with wrong arguments in a
  114-task run. This is not yet measured by replay.
- ac38a37: Every doc example in the SDK now compiles: a fence whose point is another file
  (a tool reading a slot from shared.ts, a workflow body beside the agent.ts that
  declares it, a spec importing the tool it runs) carries that file as // file:
  sections, which the doc-example gate compiles at their paths. The workflow()
  docs imported WorkflowContext from a subpath that does not exist; they now
  import it from the root.
- 1f6553d: Templates: mark twelve more tools that commit an effect as writes
  (`effect: "write"`); the agent guide says what a declared write turns on.
- 6a967bc: Document the turn-taking end-of-turn window
  (turnTaking.minSilenceMs/maxSilenceMs and assemblyAIStt's
  minTurnSilenceMs/maxTurnSilenceMs) in the authoring guide, and correct the
  maxTurnSilenceMs doc comment's stated default to 3500.
- 1f6553d: The default prompt's confirmation rule no longer lets a request stand in for a
  yes when the agent's own instructions require an explicit confirmation, and it
  says what a yes is: an answer to a question the caller heard. A backchannel
  ("uh-huh") over the agent's speech is not agreement, and a yes after a reply
  that ended in `[interrupted]` cannot answer a question the cut removed, so the
  agent asks again before acting. On tau2 retail, three writes ran without a heard
  yes, one of them licensed by the old "the request is the authorization" line.
  This is not yet measured by replay.
- 1f6553d: The default prompt's lookup-recovery ladder now handles a spelling that is
  itself mis-heard. Once a spelled value has failed, the agent asks for each
  letter with a word ("S as in Sam, F as in Frank") and sends only the letters,
  because letter names like S/F and M/N sound alike over a voice line. The
  letter-confusion retry also swaps every copy of a confused letter at once. On a
  tau2 retail call the caller spelled S-S three times, was transcribed F-F each
  time, and the agent transferred after six failed lookups. This is not yet
  measured by replay.
- 1f6553d: System prompt: lookup recovery. Send each field only a value the caller gave for
  that field (digits inside an email are never a ZIP — look the caller up by email
  instead); treat a spoken correction ("Sofia with an F") as a spelling even when
  the transcript wrote the common form; try other romanizations of a name, and
  change something on every retry; when asking, have the caller spell the failed
  name one letter at a time; and never transfer over a failed lookup of the
  caller's own account before it has been spelled. On replayed tau2 retail
  recoveries through TTS and STT, authentication after a failed lookup rose from
  56% to 76%.
- 1f6553d: System prompt: on a blocked request, make every allowed change before any
  transfer, offer the allowed version as an action, and treat pushback as no new
  problem.
- 1f6553d: The default prompt's TOOLS section now carries the policy rules that two
  published tau2-bench prompt studies converged on (Migliaa's airline prompt, IBM
  ALTK-Evolve's retail playbook): check the policy against the fetched records
  rather than the caller's claims or a tool's acceptance, do only what was asked,
  treat a described choice as a search over every option, confirm the whole
  request ONCE (opening "Nothing's changed yet.") and then make every write that
  yes covered without asking again, and transfer a blocked request only after the
  caller has heard and answered the obstacle. The confirmation bullet exempts that
  one reply from SPEAKING's two-sentence cap and no-preface rule (stated in TOOLS,
  so a tool-less agent's prompt names no section it lacks), and the record and
  policy rules name the records generically rather than a retail profile. Every
  agent with tools gets them; an agent's own instructions still win on policy.
  Neither study ran on voice, and this is not yet measured here.
- 1d6304d: composio(): two calls that lose the same Composio session at once now share one
  remake, so neither fails with a 404 when the session store's delete is slower
  than its get
- fccf609: Bound three guest resource bypasses found by adversarial testing: the coding
  tools' `grep` runs a model-supplied regex in a terminable worker (a catastrophic
  pattern no longer wedges the whole process), `run_code` caps the console output
  it keeps, and the studio's `download_to_workspace` stops reading a response at
  the file cap instead of buffering it whole.
- 1f6553d: System prompt: a name, email address or lettered code the caller only said is
  spelled letter by letter and read back once — with a word for each letter that
  sounds like another — and confirmed before it reaches a tool. This replaces "try
  it before asking for it spelled": a homophone ("Mei" heard as "May") is a
  correct transcription, so only the caller's letters recover it. Digits said one
  by one need no spelling, and a value already confirmed is never asked again.
- 1f6553d: AssemblyAI TTS now sends a `KeepAlive` frame when its socket has been quiet for
  `TTS_KEEPALIVE_INTERVAL_MS` (30 s). The service closes a socket that receives
  nothing for 120 s, and the pipeline treats that close as fatal, so a long
  stretch with no agent speech used to end the call: on a tau2 retail run the
  session tore down and the agent answered none of the caller's next four
  utterances.

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
