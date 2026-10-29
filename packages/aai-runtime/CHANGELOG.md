# @alexkroman1/aai-runtime

## 0.18.0

### Minor Changes

- 1f6553d: Speech made only of acknowledgement words ("mm-hmm", "yeah, right", "exactly"),
  when it starts while the agent is speaking, no longer cuts the reply and is not
  committed as a turn. The reply keeps playing. The same words after the agent has
  stopped still commit as an answer. On Full-Duplex-Bench v1.5, backchannels that
  cut the reply fell from 94 of 98 to 4 of 98, and the judged Resume rate rose
  0.67 → 0.94.
  
  The barge-in sustained-speech gate no longer reads `SttTurnMeta.spokenMs`. On
  `universal-3-5-pro` a turn's first word is timestamped from the start of the
  turn window, not from speech, so a one-word "Hmm." spoken over ~1s reported
  ~1.1s and passed the 500 ms gate at once. An interim now passes when the speech
  edge has been open for `interruptionMinDurationMs`, or when it already has 3 or
  more words. The `Pipeline barge-in` log line now carries the gate's inputs
  (`words`, `spokenMs`, `edgeMs`) and the interim's text.
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
- 1f6553d: Speech that begins while the agent is speaking now goes through the barge-in
  rules even when it falls inside the continuation window. Continuation is for the
  rest of a sentence the caller started before the reply was audible. It used to
  also take speech that began over the reply, and that path skipped every barge-in
  safeguard: one interim word cut the reply at once. On Full-Duplex-Bench v1.5 it
  decided 350 of 352 such overlaps. A backchannel cut the answer ~0.3s in, was
  committed onto the question, and the answer restarted from the top.
  
  The barge-in sustained-speech gate (`interruptionMinDurationMs`) now also
  accepts the interim's own word span (`SttTurnMeta.spokenMs`). Before, it timed
  only from the first interim's arrival. AssemblyAI's first interim can come ~1.3s
  into an interruption already five words long, so the cut waited for a second
  interim, ~1.8s after the caller started. It now lands ~0.4-0.6s in. A provider
  without word timings keeps the old clock.
- 1f6553d: A committed transcript that began over agent speech and whose words span less
  than `interruptionMinDurationMs` is now an acknowledgement: it no longer cuts
  the reply, and it is not committed as a turn. Finals used to skip that gate, so
  with `minBargeInWords` at 1 every one-beat "uh-huh" cut the agent off (334 of
  367 on six tau2 retail runs). The model then read it as the caller's answer:
  "Shall I request the return?" / "Uh-huh." ran a write tool 11 times with no
  consent given. AssemblyAI STT now reports the words' span as
  `SttTurnMeta.spokenMs`. A provider without word timings keeps the old behaviour.
- 1f6553d: New pipeline defaults, measured on tau2-bench retail: `minTurnSilenceMs` 1600 →
  800, `interruption.continuationWindowMs` 2500 → 3500, and `assemblyAIStt` now
  sends `vad_threshold` 0.02 (`DEFAULT_VAD_THRESHOLD`; it sent nothing before, so
  the service's 0.2 applied). The 800 ms floor relies on continuation re-joining a
  turn split mid-sentence — an agent that sets `continuationWindowMs: 0` should
  also set `minTurnSilenceMs: 1600`. At 0.02 a caller voice the service gate had
  dropped entirely is heard; watch background-speech leakage in noisy rooms.
- 5a7e065: AssemblyAI STT now reopens a socket that has gone deaf: open and taking audio,
  but sending no partial or final while the caller talks. Two signs trigger it.
  The first is 2.5 s of voiced audio (15 dB over the line's noise floor and above
  -45 dBFS) with no turn event. The second is a partial left open longer than
  `maxTurnSilenceMs` + 1.5 s. The new socket is sent the last 3 s of audio first,
  then the session's live `min_turn_silence` and keyterms. The old socket's final
  flush is still accepted while it drains. On tau2-bench retail
  (`universal-3-5-pro`), 4 of 5 sims flagged unresponsive sat in a 42–90 s window
  with no STT events. A raw websocket client reproduces it, and a fresh socket
  hears again. On recorded calls, reopening and replaying heard 54 of 58 caller
  utterances against 5 without. Each reopen logs `AssemblyAI STT reopened`.
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
- 1f6553d: MCP tools now carry an `effect`, taken from the server's `readOnlyHint` by MCP's
  own default: a tool is a write unless its server marks it read-only, so an
  unannotated third-party tool gets the write confirmation gate.
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
- af9fb16: aai start --workers N serves one build from N processes: client-affinity routing
  (no database required; DATABASE_URL adds crash survival), primary-owned
  lifecycle with drain (--drain-timeout), SIGHUP rolling restart and per-worker
  admission (--max-calls-per-worker). Runtime: per-frame hot paths memoized,
  provider frames sent in one TLS write per tick, model-provider connections kept
  alive 30 s across turns, pooled event-id randomness and a TTS audio fast path.
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

- 1f6553d: A required string argument sent empty or as whitespace is now refused before the
  call runs, like a missing one, unless the parameter says empty is a real answer
  (its `enum` holds `""`, or its description names an empty value, as tau2's
  `address2` does with "such as 'Apt 1' or ''"). On tau2 retail,
  `find_user_id_by_email({ email: " " })` and `last_name: ""` went to the client
  and came back "User not found".
- 1f6553d: A tool result's record table now tallies each boolean column in its header —
  `12 records (key column: item_id; available: 10 true, 2 false)`. The header used
  to give only the row count, and a model asked how many items were available
  answered with it ("twelve t-shirt options" for a 12-row table with two
  unavailable, twice in one tau2 retail run). Only columns whose every cell is a
  JSON boolean are tallied.
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
- f1a994b: installStubFfmpeg on @alexkroman1/aai-runtime/testing/vitest scripts the child
  the SDK's ffmpeg runners spawn, so a step that shells out to ffmpeg runs end to
  end in a unit test with no binary; the SDK's ffmpegProcess seam is on
  /host-internal for it
- 1f6553d: When the caller's speech cuts a reply and then commits a turn, the model's copy
  of that turn now says where the reply stopped being heard and asks it to finish
  what was cut unless the caller's words answer, redirect or stop it. Previously
  such a turn held only `… [interrupted]`, and an acknowledgement ("uh-huh") — 17%
  of barge-ins on a tau2 retail run — lost the rest of the reply, including any
  question in it. The model decides; nothing reads the caller's words in code. The
  client transcript and the conversation record are unchanged.
- 1f6553d: Tool calls that already failed with the same arguments are no longer run again.
  The session remembers failed calls and answers an identical repeat with a
  `repeated_failure` result telling the model to change something, before the tool
  runs — so no tool speech, and in host mode no relayed call. A failure's model
  copy also lists every failed call so far. Any success, or a reset, forgets them.
  This replaces the tool-error budget's rule that let an identical repeat run and
  then ended the turn; on replayed tau2 retail recoveries it halved identical
  resends (44 → 18).
- 1f6553d: A tool argument written in a different shape from every value the conversation's
  records have shown for the same field is refused once, naming the records' form
  — a state the agent just said aloud as "New York" where the user record holds
  `"CO"`, or a ten-digit id sent truncated. Only tight shapes qualify (2-3
  capitals, fixed-length digits, `#W`+digits), only an argument of the same kind
  is refused (a capitalized name for a capitals field, never `"delivered"` where
  one record said `"OK"`), and re-sending the identical value after the refusal
  runs it. Each settled result is read whole, so a record too large for the
  history's capped copy still counts. On tau2-bench retail it fired 18 times in
  6,799 tool calls, all on malformed arguments; at the six leaked address writes
  the model's next call used the two-letter form 17 of 24 times on replay.
- 1f6553d: A client's `playback_progress` report now has the audio the session's pacer is
  still holding added before it reaches the heard cursor. A client can only report
  what it has received, so a client playing slower than real time left the held
  audio uncounted — and a barge-in then discarded it unsent — putting the heard
  cursor ahead of the caller's ear and making resumes skip words they never heard
  ("one thousand four hundred ninety-seven dollars" resumed as "four hundred
  ninety-seven dollars"). Instrumented on tau2-bench retail, the cursor went from
  a median 3 (max 11) words past the audio actually played to 0 (max 1).
- 1f6553d: A host-mode (relay) session now logs `Host builtin tool` for every builtin the
  host runs itself, with the tool name and, for `think`, the thought (a character
  count in production). The client only receives a `tool.called` for a tool it has
  to run, so a relay harness such as tau2 had no record of whether the model used
  `think` before a write.
- 1f6553d: A pipeline LLM response that goes silent is abandoned after 15 s (before its
  first chunk, or between chunks) instead of hanging until undici's 300 s body
  timeout, and one that stalled before the model said or did anything (and before
  any error reached the client) is re-sent once, silently. The between-chunks
  clock times the model's own stream only, so a tool that runs longer than 15 s is
  never aborted by it. A stall after output is never re-sent (a completed step may
  have run a write tool) and fails the turn with the recovery phrase. Measured on
  tau2-bench retail: a gateway `200` with a stalled body held one call for 5 min
  while the filler looped over ~20 unanswered caller turns; no healthy turn in two
  114-task runs came within 12.3 s of the deadline.
- 1f6553d: Raise the per-turn tool-error budget from 3 to 6. Three failed lookups forced an
  answer halfway through the lookup-recovery ladder the system prompt asks for
  (earlier hearings, letter confusions, other spellings of a name), so homophone
  names (Sofia/Sophia, Yusuf/Yusef) failed authentication and the call was
  transferred.
- 90f9990: Two abort idioms in the runtime brought in line with the rest of the package. A
  speculative LLM stream adopted by a turn now forwards the turn's abort REASON
  into its own controller instead of aborting with none, so a reader of the
  request's `signal.reason` sees the barge-in's, as it already does for a tool's
  per-call controller. The header-WebSocket connect race is a plain
  `Promise.withResolvers()` deferred rather than a private `EventEmitter` driven
  through `p-event`; behaviour is unchanged.
- 1f6553d: Tool arguments are checked against the tool's declared parameters before the
  call runs: a missing required parameter, a placeholder (`"unknown"`, `"?"`,
  `"n/a"`) standing in for a value, or an undeclared parameter where the schema
  sets `additionalProperties: false` is answered with an `invalid_arguments`
  result instead of being sent. Host and MCP tool schemas were never enforced, so
  these calls reached the tool. A failed call that sent a required string empty is
  told so in the model's copy of its result (an empty string is not refused, since
  it can be a real answer).
- 1f6553d: AssemblyAI TTS now sends a `KeepAlive` frame when its socket has been quiet for
  `TTS_KEEPALIVE_INTERVAL_MS` (30 s). The service closes a socket that receives
  nothing for 120 s, and the pipeline treats that close as fatal, so a long
  stretch with no agent speech used to end the call: on a tau2 retail run the
  session tore down and the agent answered none of the caller's next four
  utterances.
- 1f6553d: Every refusal a tool call gets before it runs now says whether the identical
  call will run if sent again: an argument precheck or a repeated failure is
  refused again; a format-mirror refusal runs on the re-send.
- 1f6553d: The pipeline's write confirmation gate now refuses a declared write only when
  the caller turn behind it was a backchannel: begun over agent audio AND shorter
  than `interruptionMinDurationMs` of speech. Overlap alone refused real answers:
  on tau2 retail a caller twice began "Yeah, cancel that charger order" over the
  last ~1.4 s of the question and the task failed. The refusal now tells the model
  to ask once more and wait, rather than reading as a failed action. Without word
  timings, overlap still refuses.
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [ac38a37]
- Updated dependencies [f1a994b]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [6a967bc]
- Updated dependencies [5a7e065]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [e7cc510]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1d6304d]
- Updated dependencies [1f6553d]
- Updated dependencies [fccf609]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
  - @alexkroman1/aai@0.18.0

## 0.17.0

### Minor Changes

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

### Patch Changes

- 130bc0c: Transcript logging is off in production. A contained guest
  (`AAI_SANDBOX_CONTAINED=1`) or a process under `NODE_ENV=production` no longer
  writes what was said to its log, whatever `AAI_DEBUG` says: the STT turn trace,
  the committed-turn trace, the quiet-final and barge-in-veto lines, a tool's
  spoken line and the S2S `tool.call` payload carry a character count
  (`textChars`, `transcriptChars`) in place of the text. Under `aai dev` and in
  tests the verbatim trace is unchanged.
- Updated dependencies [a8a37ac]
- Updated dependencies [b1d73be]
- Updated dependencies [8f93cca]
  - @alexkroman1/aai@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [06d09d5]
  - @alexkroman1/aai@0.16.0

## 0.15.5

### Patch Changes

- @alexkroman1/aai@0.15.5

## 0.15.4

### Patch Changes

- @alexkroman1/aai@0.15.4

## 0.15.3

### Patch Changes

- Updated dependencies [4a291dd]
  - @alexkroman1/aai@0.15.3

## 0.15.2

### Patch Changes

- @alexkroman1/aai@0.15.2

## 0.15.1

### Patch Changes

- 89737d1: Test phone trees: eval sessions now carry sendDtmf presses (they answered "call
  ended" on every press, so a phone-menu tool told a live model the call was over)
  and report them as `turn.dtmf`; new `walkPhoneTree(session, tree)` plays an
  automated menu declared as data and follows the keys the agent actually pressed.
  The outbound-call-agent template gains phone-tree evals, a same-reply hang-up
  rule, and a `scripts/phone-tree-call.mjs` harness that has a deployed agent dial
  a real Twilio menu.
- 9ed592e: First-run fixes from user feedback: the stock Controls row gains an End Call
  button (session.end()); an LLM Gateway 400 for a model the account cannot use,
  or one without tool calling, now names the fix; the scaffold .env.example and
  authoring guide explain when a database is needed and where to set the model.
- @alexkroman1/aai@0.15.1

## 0.15.0

### Patch Changes

- Updated dependencies [851a4ab]
  - @alexkroman1/aai@0.15.0

## 0.14.4

### Patch Changes

- Updated dependencies [d266c27]
  - @alexkroman1/aai@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [d648b81]
  - @alexkroman1/aai@0.14.3

## 0.14.2

### Patch Changes

- f7c51dc: Drop stale provider frames found by new concurrency property tests. OpenAI
  Realtime no longer delivers a cancelled or barged-in reply's trailing audio,
  transcript or tool call, no longer commits a transcript fragment to history
  after a barge-in, and reports nothing after `stop()`. Cartesia TTS no longer
  emits `done` or sends a wire cancel when barge-in fires before any text.
- Updated dependencies [d66b0c3]
  - @alexkroman1/aai@0.14.2

## 0.14.1

### Patch Changes

- @alexkroman1/aai@0.14.1

## 0.14.0

### Patch Changes

- 3c0d0dd: Fix three cancel races found by new property tests. A client `reset` no longer
  lets an aborted tool call's result settle into the fresh conversation (its
  history and the `tool.completed` log). In the AssemblyAI TTS adapter, a barge-in
  after a reply had finished no longer drops the is_final/FlushDone pairing, which
  let the old turn's trailing FlushDone end the next reply before its last segment
  played; and a turn begun under an unanswered `Cancel` now ends when the
  acknowledgement deadline drops the socket, instead of never emitting `done`.
- b77171d: Studio idle reaping binds the sandbox with `await using`, so it is terminated
  even if a release step throws; the remaining hand-rolled waits use the shared
  primitives.
- 66953d5: An MCP connect that times out now aborts its in-flight fetches instead of
  leaving them to the SDK's own request timeout. The orchestrator exposes
  `stopSweeps` so a test-built one stops its queue sweep.
- dd2e1db: Make `EgressPool.close()` idempotent as documented: a second call now returns
  the first call's settlement instead of rejecting with undici's
  `ClientClosedError`
- a9267f2: Model-provider fetch wrappers now take their delegate as a required argument,
  named once by the LLM registry (still the ambient fetch, read per call); agent
  boot artifacts in a contained guest are written under the guest scratch dir
  (/var/tmp) instead of a hardcoded /tmp.
- Updated dependencies [5fa348b]
- Updated dependencies [f6aa687]
- Updated dependencies [67f7354]
- Updated dependencies [8820f2c]
- Updated dependencies [f869b6a]
- Updated dependencies [99400e3]
- Updated dependencies [5fa348b]
- Updated dependencies [5ded42b]
- Updated dependencies [99400e3]
  - @alexkroman1/aai@0.14.0

## 0.13.0

### Minor Changes

- The first `0.x` release. Versions 1.0.0 through 18.0.0 were pre-release history and are not carried forward; this line restarts at 0.13.0, the lowest `0.x` not already on the registry. During `0.x` a breaking change is a minor bump.
- Every deprecated API is removed: `createRuntimeServer` (use `createServerForRuntime`), `AgentInstructions` (`Exclude<AgentSystemPrompt, string>`), `StaticAgentParams` (`WorkflowAppAgentParams`), `scriptedToolContext` and its two types (`createToolContext` takes the `generate`/`delegate` scripts and exposes `ctx.model`/`ctx.desk`), `SessionSlot.projection(view)` (declare `sessionSlot(key, create, { view })` and pass `slot.projected`), the record form of `agent({ syncState })` (pass a projection or a list), and `aai test --all` (now a usage error).
- Every legacy fallback is removed: `session.configured.sessionId` is required and `?resume=1` is gone, the platform base URL is read only from `AAI_PLATFORM_BASE_URL`, and a configuration with no stages is S2S only with an explicit `s2s` descriptor.
- Every API contract epoch restarts at 1.
