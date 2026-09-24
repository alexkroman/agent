---
summary: >-
  Which template is the worked example of which SDK primitive, and the
  per-template accounts behind `research-handoff-agent`,
  `transcription-workflow`, `meeting-recap-agent` and the dialog templates
read_when: >-
  looking for the reference use of an SDK export, adopting or removing one in a
  template, or working inside one of those templates
---

# packages/aai-templates — worked examples

A sibling of `packages/aai-templates/CLAUDE.md`, read on demand. The rules
these templates demonstrate are in that guide; this file says WHERE each one is
demonstrated and what building the example settled.

## Which template demonstrates which primitive

`template-api-coverage.test.ts` enforces that every public export is exercised
somewhere (see `src/CLAUDE.md`). This table is the converse: where to look for
the reference use. When you remove a template's use of an export, check this
table and the allowlist — "the last remover pays".

### Session state and tools

| Primitive | Demonstrated by |
| --- | --- |
| `sessionSlot()` | every stateful template; `pizza-ordering-agent` is smallest; `retail-orders-agent` (slot in `store.ts`) and `hotel-reception-agent` (`session.ts`) keep the view in `shared.ts` so the seed stays out of the browser bundle |
| `slot.projection(view)` as `syncState` | `pizza-ordering-agent`, `emergency-dispatch-agent`, `retail-orders-agent`; `tabletop-rpg-agent` projects `gameView`, withholding seven fields and unplayed acts. Six templates export the projection from the slot's module and import it at both ends |
| `slot.update` | `emergency-dispatch-agent` (every mutating tool, plus an `after` hook); `research-planner-agent`'s `work_next_step` claims its step inside the window and awaits outside it — the shape for a body that needs a model call |
| `slot.updateTool` | `retail-orders-agent`, all tools via `retailTool`: the wrapper owns the auth gate and activity log and passes the DRAFT to the body |
| `slot.tool` | `pizza-ordering-agent`, `travel-concierge-agent`, `executive-inbox-agent`, `text-adventure-agent`, `tabletop-rpg-agent` (`save_game`: an async body is fine, only `updateTool` must be synchronous), `emergency-dispatch-agent` |
| `sessionSlot(key, create, { caps })` | ten templates, each declaring the bound on the slot and pushing directly; surviving `MAX_*` constants are the ones a spec reads |
| `pushCapped` | `emergency-dispatch-agent` only — a NESTED list per incident, the one shape `caps` has no key for |
| `createKeyedLock` / `withLock` | `roadside-assistance-agent` (`yard.ts`, keyed by truck kind), `applicant-screening-agent` (`screening-lock.ts`, keyed by session). Not used inside `slot.update`, which is already atomic |
| `ToolFailure` / `isToolFailure` | `retail-orders-agent` (~40 sites through `store.ts`), `emergency-dispatch-agent` |
| `resolveOne` + `ResolveOneOptions` | `retail-orders-agent` (`resolve.ts`), `applicant-screening-agent`, `topic-briefing-agent`, `entertainment-picks-agent` (hand `score` for plural stemming), `hotel-reception-agent`, `executive-inbox-agent`. Only `tabletop-rpg-agent` (`findClock`) uses bare `spokenOrdinal` |
| `spokenDigits` / `spokenAlphanumeric` | `retail-orders-agent` (`normalizeOrderId`), `roadside-assistance-agent` (`normalizePolicy`) |
| `roundMoney` | `pizza-ordering-agent`, `travel-concierge-agent` (both load-bearing); `hotel-reception-agent` counts integer cents and correctly does not use it |
| `ToolDef.onError` | `topic-briefing-agent`'s `send_briefing` — a CLASSIFIER: re-throwing makes an unset webhook fatal instead of a retry loop until `maxSteps` |
| `agent({ description })` | all 30 — read by the registry, `aai list` and the studio picker, never by the model |
| `agent({ systemPrompt })` as a resolver | `text-adventure-agent` (`statusBlock`), `tabletop-rpg-agent` (`liveSheet`): the board goes into the instructions instead of a compulsory read-back tool call every turn. Both close over their own `?raw` import |
| `agent({ outputGuardrails })` | `emergency-dispatch-agent` (`guardrails.ts`), `medication-safety-agent` (`refuseDoses`) — pipeline-only, since s2s has already spoken |
| `agent({ usageLimits })` | `retail-orders-agent`, `web-research-agent`, `applicant-screening-agent` (the cap covers `ctx.generate` and `ctx.delegate`) |
| `agent({ events })` + `SessionEventHandlers` | `roadside-assistance-agent`, `travel-concierge-agent`, `hotel-reception-agent` (hang-up leaves an `abandoned_booking` followup), `emergency-dispatch-agent` (records a dropped call and deliberately does NOT move the dialog) |
| `agent({ mcpServers })` | `web-research-agent` only — gated on its URL env var so the starter deploys without it; configured, it lists `tokenEnv` in `requiredEnv` itself. `mcp_` tools fall under the same citation and prompt-injection rules as builtins |

### Model calls, subagents, dialogs

| Primitive | Demonstrated by |
| --- | --- |
| `ctx.generate` with a `schema` | `technical-support-agent` (five graders + rewriter), `research-planner-agent`, `executive-inbox-agent`. `travel-concierge-agent` deliberately uses none |
| `dialog()` + `dialog.tool` + `dialog.send` | eight templates; see "A flow is WHERE A CONVERSATION IS" in `CLAUDE.md` for the reading order |
| `agent({ dialogs })` + `Dialog.receive` / `.timeout` / `.voiceConfig`, `AnyDialog` | `roadside-assistance-agent` (and `executive-inbox-agent`, for the hang-up) |
| `procedure()` | `technical-support-agent` — the CRAG loop inside one tool call, with `ctx.signal` |
| `subagent()` + `ctx.delegate` | `topic-briefing-agent` (four subagents, `Promise.allSettled`, `stubDelegate`), `executive-inbox-agent`'s meeting assistant. Argued in `packages/aai-runtime/src/CLAUDE.md`, "Subagents" |
| `agent({ subagents })` + `SubagentRoster` | `topic-briefing-agent`: name a subagent in code when the tool IS the choice; put it on the roster when the caller's words are |
| `SubagentDef.expectedOutput` | all four of `topic-briefing-agent`'s; its spec asserts each declares one |
| `SubagentDef.guardrail` | `applicant-screening-agent`'s `emailWriter`, `executive-inbox-agent`'s meeting assistant, `research-planner-agent`'s executor. `topic-briefing-agent`'s `factChecker` moved to `schema` — reach for a guardrail only when a schema cannot say it |
| `SubagentDef.tools` | `research-planner-agent`'s executor gets its own `search`/`read` over `@alexkroman1/aai/tools`, keeping `/tools` exercised |
| `stepDelegate` | `research-handoff-agent`'s `investigate`: `maxSteps` is the budget, the forced final answer the stop rule, `expectedOutput` the compression |
| `personas()` + `Personas.handoff` + `HANDOFF_TOOL_NAME` | `front-desk-agent` — three desks; code handoff, model routing, per-desk gating |
| `mapSettled` + `partitionSettled` | `applicant-screening-agent` (`crews.ts`), `topic-briefing-agent` (`research_topic`) |
| `webSearch` / `visitWebpage` | `research-planner-agent` only, from an ordinary tool body |

### Workflows and steps

| Primitive | Demonstrated by |
| --- | --- |
| `workflow()` + `ctx.workflows` + `isTerminal` | `research-handoff-agent` (the handoff), `meeting-recap-agent` (plus `cancel` and a live-run check) |
| `mapConcurrent`, `stepEmit`, `stepEnv`/`requireStepEnv`, `stepGenerate`, `stepFetch`/`multipartBody` | every workflow template, imported from `@alexkroman1/aai/step` |
| `stepGenerateJson` + `stripJsonFence` | `research-handoff-agent`, `link-digest-workflow`, `document-redline-workflow`, `meeting-recap-agent`; `stripJsonFence` only through `stepGenerateJson` |
| `toStepError` / `throwStepError` / `throwFatalStepError` | every workflow template |
| `stepFetchOrFail` | `link-digest-workflow`, `meeting-recap-agent`'s `request()`, `podcast-digest-workflow`'s `fetchText`. `meeting-recap-agent`'s DELETE stays on raw `stepFetch` (404 = already deleted) |
| `stepTranscribeUpload` / `Submit` / `Poll`, `stepTranscribeSync` | the three transcribing templates; `transcription-workflow` is the reference (`batch.ts`, `sync-api.ts`); `meeting-recap-agent` converts SUBMIT only |
| `stepSpeak` + `stepWriteUpload` + `WorkflowApi.download` | `spoken-summary-workflow` only |
| `runFfmpeg` / `probeMedia` / `wavEncodeArgs` | `call-audit-workflow` (argv built by pure functions in `workflows/media.ts`); `transcription-workflow`'s `normalize.ts` is the smallest use. See `FFMPEG-CLAUDE.md` |
| `encodeWav` + `pcmDurationMs` | `call-audit-workflow`, `transcription-workflow` |
| `throwFfmpegStepError` | `call-audit-workflow`, `transcription-workflow`. `isFfmpegError`/`FfmpegError` are allowlisted: the SDK classifies structurally |
| `withTempDir` / `readUploadToFile` / `writeUploadFromFile` | `call-audit-workflow`, `transcription-workflow` |
| `ttsVoiceIds`, `ASSEMBLYAI_TTS_DEFAULT_VOICE` | `spoken-summary-workflow`, `call-audit-workflow`; the default voice also in `custom-pipeline-agent` |
| `slack` / `sendToChannel` | `podcast-digest-workflow`; `workflows/slack.ts` keeps only the digest as a `ChannelMessage`. `isSlackWebhookUrl` refines `agent.ts`'s schema |
| `WorkflowInputOf` / `WorkflowRunOf` / `lastLine` | `podcast-digest-workflow`, `call-audit-workflow`, `spoken-summary-workflow` (input type — obliges an annotation on the def); `research-handoff-agent`, `meeting-recap-agent` (the other two) |
| `formatBytes` / `formatDuration` / `countWords` / `plural` | seven templates on both sides of the bundle boundary, so a step's report and the page agree |
| `decodeHtmlEntities` | `medication-safety-agent`, `podcast-digest-workflow` (as `decodeXml`). Tag stripping did not move |

### Clients

| Primitive | Demonstrated by |
| --- | --- |
| `useAgentState(projection)` | eight templates passing the projection itself; `entertainment-picks-agent` also shows a slot beside `useEvent`/`useToolCallStart` (rule in `packages/aai-ui/CLAUDE.md`) |
| `useAgentState(fallback)` | `retail-orders-agent`, `hotel-reception-agent` — the projection overload calls `create()`, which would ship their seeds (107 KB / 18.5 KB) to the browser |
| `AutoScroll`, `useUserTranscript`, `SessionStateDot`, `SessionControls`, `ConversationView` | the three custom chromes: `emergency-dispatch-agent`, `retail-orders-agent`, `text-adventure-agent` (`SessionControls`'s Start branch unused there by design). `useSessionControls`: `push-to-talk-agent` alone |
| `SessionErrorBanner` + `AGENT_STATE_LABELS` + `useSessionStatus` | `text-adventure-agent`, `retail-orders-agent`; the dot now calls the latter two, so their direct exercisers are gone |
| `ToolCallRow variant="compact"` | `emergency-dispatch-agent`, `retail-orders-agent`; `text-adventure-agent` deliberately keeps its bracket line |
| `mountPage()` + `useWorkflowSubmit` | `link-digest-workflow` — hand-written form, raw primitives |
| `Form` + `WorkflowFields` + `useWorkflowSubmit`, `useWorkflowRun` | `transcription-workflow` — all-declared form, no field markup |
| `FileField`, `TextAreaField` beside `<WorkflowFields>` | `document-redline-workflow` — `<FileField read="text">` and the mixed form ("Forms" in `packages/aai-ui/src/components/CLAUDE.md`) |
| `WorkflowProgress`, `WORKFLOW_STATUS_LABELS` | `transcription-workflow`, `document-redline-workflow` (whole narration); `link-digest-workflow`, `podcast-digest-workflow` (`lines={1}`) |
| `WorkflowRunPanel` | `document-redline-workflow`, `transcription-workflow` (`live={<LiveTranscript>}`) |
| `WorkflowPendingNote` + `WorkflowRunError` | the six workflow-app pages; `transcription-workflow` keeps `recover.ts` because its streaming mode has a fourth branch (a reload ENDS the run) |
| `useDownloadUrl`, `AudioResult` | `spoken-summary-workflow` (passes `captions`), `call-audit-workflow` (omits it; text rendered in full) |
| `.aai-scroll`, `--aai-scrollbar-thumb`, `aai-pulse` | the four chromes; a pulsing WORD uses Tailwind's `animate-pulse`, since `aai-pulse` also scales |

### Testing helpers

| Primitive | Demonstrated by |
| --- | --- |
| `createToolContext` | `emergency-dispatch-agent`, `pizza-ordering-agent`, `retail-orders-agent`, `tabletop-rpg-agent` |
| `toolOf` / `runTool` / `toolRunner` | ten specs, each opening `const run = toolRunner(agentDef);` — do not write a narrower per-spec wrapper |
| `expectToolOk` / `expectDialogOk`, `parseToolInput` / `parseSchemaInput` | gated-result unwraps; fail at the call instead of three assertions later |
| `expectDialogRefused` / `dialogRefusalPattern` | that a gate HELD; never pin the refusal sentence by regex. `applicant-screening-agent`'s unit spec; evals take `dialogRefusalPattern(state)` |
| `deployedAgent` | `retail-orders-agent/registry.test.ts` only; every other spec imports `virtual:aai/agent` (served by `aaiAgentPlugin()` in `vitest.config.ts`) |
| `stubGenerate`, `scriptedToolContext`, `runGuardrail` | `technical-support-agent`, `research-planner-agent`, `executive-inbox-agent`, `applicant-screening-agent` |
| `stubStepDelegate` / `installStubStepDelegate` | `research-handoff-agent`, both tiers — the unpublished slot THROWS |
| `installStubStepFetch`, `stubStepFetch` | every workflow spec — never stub `globalThis.fetch`, which tests a fallback production never takes |
| `installStubGateway` | `research-handoff-agent`, `link-digest-workflow`, `document-redline-workflow`, `meeting-recap-agent` (bare `stubGateway` is allowlisted) |
| `stubTranscribe` | the three transcribing templates |
| `stubSpeech` + `stubUploads(…, { writable: true })` | `spoken-summary-workflow` |
| `createRunSnapshot` + `createProgressStream`, `installStubWorkflows` | `research-handoff-agent`, `meeting-recap-agent` |
| `expectDeployable` | the four starters plus `medication-safety-agent`; it returns the resolved config. When it is the test's only claim, wrap it in `expect(…).not.toThrow()` — the assertion gate counts `expect` |
| `expectPromptBuiltinsDeclared` | `code-interpreter-agent`, `medication-safety-agent`, `web-research-agent`; fails on a prompt naming no builtin. `commandedBuiltins` is allowlisted |
| `runCodeIn` + `runCodeOutput` | `code-interpreter-agent`, `entertainment-picks-agent` (`packages/aai-runtime/TEXT-AGENT-CLAUDE.md`) |
| `expectToolBeforeSpeech` + `EvalTurn.errors` / `errorsIn` | `code-interpreter-agent`, `web-research-agent` (ordering); `quickstart-agent`, `custom-pipeline-agent` (errors) |

## Dialog templates

Reading order for flows: `travel-concierge-agent` (two states, one gate),
`research-planner-agent` (a lifecycle), `retail-orders-agent` (terminal state,
nested confirmation gate), `tabletop-rpg-agent` (nested, plus `final`),
`emergency-dispatch-agent` (a board — see below), `roadside-assistance-agent`
(what a dialog does when no tool runs).

- **`emergency-dispatch-agent`** holds many incidents, and a flow has one
  position per session, so `working.monitoring` means "the incident last
  touched has units", never "every incident does". Its six gated tools gate on
  the PARENT state (has anything been logged this shift); the children carry
  the instruction.
- **`roadside-assistance-agent`**: `on: { "@user-transcript.committed":
  "locating" }` on the state itself is the silence ladder (re-arms on every
  committed turn); `onCall.verifying` declares no chatter transition, so its
  deadline is wall clock. `onCall.quiet` is the ladder's landing rung (a
  shorter question). `service_disclosure` hands over the words and
  `acknowledge_disclosure` advances a turn later, so the disclosure is spoken
  under `bargeIn: "off"`. `toolChoice` is pinned on `onCall.dispatching`, not
  on `verifying`; `dispatch_truck` is idempotent. The hang-up
  (`@session.timed-out` → final `abandoned`) is declared once on the `onCall`
  parent. `agent.test.ts` asserts no state declares `voice`/`keyterms`.
- **`retail-orders-agent`**: the seven changing tools are STAGERS writing a
  `PendingAction`; `confirm_change` is the only store writer, gated on
  `serving.awaitingConfirmation`; `cancel_change` drops unconditionally.
  `IDENTIFIED` is not handled on `serving`, since that self-transition would
  re-enter and strand the pending change. Plans hold ids and amounts, not
  store references, so a persisted session can carry them. `registry.test.ts`
  pins seventeen tool names. Its wrapper's activity log does not record a gated
  refusal (stated at the wrapper).
- **`tabletop-rpg-agent`**: `gameOver` is `final`; `setup_character` calls
  `dialog.reset`. `isGameOver`/`inCrisis` predicates sit beside the `after`
  hook.
- **`research-planner-agent`**: both gated tools declare `sendFrom` last and
  say so; `work_next_step` is the hardest inference case.
- **`word-game-agent`**: `playing` declares no transition except its two exits,
  and its three in-round tools send nothing, so the round timer is not re-armed.

## `research-handoff-agent`

The voice-to-workflow handoff. The body and its steps live in
`workflows/research.ts` (a convention now: a spec can import the steps alone);
the declaration is in `shared.ts` because four tools import it.

Five stages adapted from LangChain's `open_deep_research` (MIT;
`workflows/prompts.ts` has attribution and the stage mapping): `writeBrief`,
`planAngles` (fan-out width comes from this step's journaled result),
`investigate` (one `stepDelegate` researcher per angle with
`web_search`/`visit_webpage`), `findGaps`, `writeReport` (report plus two
spoken sentences). The research loop's budget is `maxSteps`, not the prompt;
the loop is journaled as ONE step result (what the researcher concluded); a
failed search is shown to the researcher, not only logged. The compression
prompt says to REPEAT relevant text rather than summarize.

Spec tiers: tools against stubbed `ctx.workflows`; steps directly against a
stubbed fetch; the body via `createWorkflowContext` and via `runWorkflow` on the
real replay engine. `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier
above.

## `transcription-workflow`

A `workflowApp()` (no `stt`/`llm`/`tts`, no tools) against AssemblyAI's SYNC
endpoint: `splitRecording` → `transcribeSegment` per chunk (fan-out forced by
the endpoint's 120 s / 40 MB cap) → `mergeTranscript`. A run that dies on
segment 27 resumes having replayed 1–26.

- The recording is UPLOADED (`uploads: ["recording"]`); each step reads its
  window with `stepReadUpload`. The template contains no upload code. The page
  shows `<UploadProgressBar>` and `<WorkflowProgress>` (two disjoint waits)
  and one press-to-transcript clock (`useTotalLatency`, `<TotalLatency>`),
  because `output.elapsedMs` misses the upload.
- Linear-PCM WAV only, named in the error with the `ffmpeg` line that fixes it;
  `workflows/wav.ts` is pure functions over journaled values.
- Segments overlap by two seconds; `stitchTranscript` drops the longest
  repeated run at each seam on a punctuation-stripped key (a missed seam
  repeats words; a false one deletes speech).
- `SEGMENT_CONCURRENCY`'s doc carries the concurrency measurements.
- Its spec drives only `transcribeBatch` durably; the two ffmpeg flows'
  durability is the scenario tier's. No template covers the webhook waitpoint;
  `dev-workflow.scenario.test.ts` does.

## `meeting-recap-agent` — the Temporal ports

`research-handoff-agent`'s shape carrying the Temporal TypeScript samples that
translate, against the real BATCH API (`transcription-workflow` takes the sync
endpoint, this one the job-id-and-poll endpoint). Both files carry the mapping.

| Temporal sample | Ported as |
| --- | --- |
| `saga` (`openAccount`) | `recapFlow`'s compensation stack, unwound by `compensate` |
| `polling` (infrequent) | `awaitTranscript` — one step plus one durable `sleep`, bounded by attempts |
| `timer-examples` (`processOrderWorkflow`) | the `Promise.race` against `PATIENCE`, then the "still going" note |
| `expense` (`timeoutOrUserAction`) | the retention gate: `ctx.waitFor(token, { timeoutMs })`, three outcomes, safe default |
| `signals-queries` (Signal) | `keep_transcript`, over `ctx.workflows.signal` |
| `signals-queries` (Query + Cancellation) | `recap_status` and `cancel_recap` |
| workflow-id reuse / `mutex` | the live-run check in `request_recap` |

- `SAMPLE_RECORDING` is the provider's public sample, because a caller cannot
  read a URL aloud; the tool still accepts one.
- `workflows/tokens.ts` is the one derivation of a signal token.
- Cancellation is NOT cooperative here: `ctx.workflows.cancel` stops replay, so
  compensations do not run and the transcript stays. `cancel_recap` says so in
  its result and the spec pins the sentence. The template stops at one hook on
  purpose.
- Its poll stays hand-written (`checkTranscript` returns the status as a VALUE
  for `recap_status` and the saga); the module says so in place.
- Spec tiers: tools, steps, body helpers against `createWorkflowContext`
  (ordering and branching only), and `recapFlow` on the real replay engine for
  "a resume does not re-transcribe" and "the unanswered window deletes" —
  `run.expireWaits()` is the only route to that branch.
