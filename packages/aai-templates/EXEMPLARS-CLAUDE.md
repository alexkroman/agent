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

A sibling of `packages/aai-templates/CLAUDE.md`, read on demand. The rules these
templates demonstrate are in that guide; this file says WHERE each one is
demonstrated and what building the example settled.

## Which template demonstrates which primitive

`template-api-coverage.test.ts` enforces that every public export is exercised
somewhere (see `src/CLAUDE.md`). This table is the converse: where to look for
the reference use. When you remove a template's use of an export, check this
table and the allowlist — "the last remover pays".

### Session state and tools

| Primitive                                       | Demonstrated by                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sessionSlot()`                                 | every stateful template; `pizza-ordering-agent` is smallest; a plain-value default everywhere the default is not computed                                                                                                                                                      |
| `sessionSlot(…, { view, sync: true })`          | `pizza-ordering-agent`, `emergency-dispatch-agent`, `retail-orders-agent`; `tabletop-rpg-agent` projects `gameView`, withholding seven fields and unplayed acts. The client takes `slot.projected`; `agent()` names nothing                                                    |
| `sessionSlot(…, { empty })`                     | `retail-orders-agent`, `hotel-reception-agent` — seeded slots whose first frame is the empty shape, so the seed never ships to the browser                                                                                                                                     |
| `slot.update`                                   | `emergency-dispatch-agent` (every mutating tool, plus an `after` hook); `tabletop-rpg-agent`'s oracle is the one-branch-writes case that stays a `tool()`                                                                                                                      |
| `slot.updateTool({ require, prepare, report })` | `retail-orders-agent` (`require` is the auth gate on every changing tool); `research-planner-agent`'s `work_next_step` is the `prepare` shape — await, then the window; `tabletop-rpg-agent` reports `gameOver` off the stored value                                           |
| `slot.transact`                                 | a plain `tool()` that must await and then write — the non-tool form of `prepare`                                                                                                                                                                                               |
| `slot.tool`                                     | `pizza-ordering-agent`, `travel-concierge-agent`, `executive-inbox-agent`, `text-adventure-agent`, `tabletop-rpg-agent` (`save_game`: an async body is fine, only `updateTool` must be synchronous), `emergency-dispatch-agent`                                                |
| `SlotValueOf` / `SlotDraftOf`                   | every helper over slot state; no template aliases `DeepReadonly<T>` by hand                                                                                                                                                                                                    |
| `sessionSlot(key, create, { caps })`            | ten templates, each declaring the bound on the slot and pushing directly; surviving `MAX_*` constants are the ones a spec reads                                                                                                                                                |
| `pushCapped`                                    | `emergency-dispatch-agent` only — a NESTED list per incident, the one shape `caps` has no key for                                                                                                                                                                              |
| `createKeyedLock` / `withLock`                  | `roadside-assistance-agent` (`yard.ts`, keyed by truck kind), `applicant-screening-agent` (`screening-lock.ts`, keyed by session). Not used inside `slot.update`, which is already atomic                                                                                      |
| `ToolFailure` / `isToolFailure`                 | `retail-orders-agent` (~40 sites through `store.ts`), `emergency-dispatch-agent`                                                                                                                                                                                               |
| `resolveOne` + `ResolveOneOptions`              | `retail-orders-agent` (`resolve.ts`), `applicant-screening-agent`, `topic-briefing-agent`, `entertainment-picks-agent` (hand `score` for plural stemming), `hotel-reception-agent`, `executive-inbox-agent`. Only `tabletop-rpg-agent` (`findClock`) uses bare `spokenOrdinal` |
| `spokenDigits` / `spokenAlphanumeric`           | `retail-orders-agent` (`normalizeOrderId`), `roadside-assistance-agent` (`normalizePolicy`)                                                                                                                                                                                    |
| `roundMoney`                                    | `pizza-ordering-agent`, `travel-concierge-agent` (both load-bearing); `hotel-reception-agent` counts integer cents and correctly does not use it                                                                                                                               |
| `ToolDef.onError`                               | `topic-briefing-agent`'s `send_briefing` — a CLASSIFIER: re-throwing makes an unset webhook fatal instead of a retry loop until `maxSteps`                                                                                                                                     |
| `tool({ ui })`                                  | every template whose page shows tool calls — the icon and label ride the declaration; no `mountClient({ tools })` map                                                                                                                                                          |
| `withInstruction`                               | the per-outcome "say it this way" a result carries; `text-adventure-agent`, `research-planner-agent`                                                                                                                                                                           |
| `ctx.turn` / `ctx.now()`                        | `text-adventure-agent` (turn count), every opening-hours or deadline check (`hotel-reception-agent`, `pizza-ordering-agent`) — pinned in specs with `createToolContext({ turn, now })`                                                                                         |
| `agent({ listing })`                            | every template — read by the registry, `aai list` and the studio picker, never by the model                                                                                                                                                                                    |
| `agent({ promptContext })`                      | `text-adventure-agent` (the status block), `tabletop-rpg-agent` (the live sheet), `pizza-ordering-agent` (the menu): computed text appended under `system-prompt.md`, which stays the prompt. No template imports the file                                                     |
| `agent({ outputGuardrails })`                   | `emergency-dispatch-agent` (`guardrails.ts`), `medication-safety-agent` (`refuseDoses`) — pipeline-only, since s2s has already spoken                                                                                                                                          |
| `agent({ usageLimits })`                        | `retail-orders-agent`, `web-research-agent`, `applicant-screening-agent` (the cap covers `ctx.generate` and `ctx.delegate`)                                                                                                                                                    |
| `agent({ events })` + `SessionEventHandlers`    | `roadside-assistance-agent`, `travel-concierge-agent`, `hotel-reception-agent` (hang-up leaves an `abandoned_booking` followup), `emergency-dispatch-agent` (records a dropped call and deliberately does NOT move the dialog)                                                 |
| `ctx.speech.say` / `SessionSpeech`              | `word-game-agent` (`armTimeUpLine` in `game.ts`): their `TTSSpeakFrame` "Time's up", said verbatim ON the dialog's clock with `interrupt: true` and `interruptible: false`, silent when the words ran out first; the deadline stays the durable clock                          |
| `agent({ mcpServers })`                         | `web-research-agent` only — gated on its URL env var so the starter deploys without it; configured, it lists `tokenEnv` in `requiredEnv` itself. `mcp_` tools fall under the same citation and prompt-injection rules as builtins                                              |

### Model calls, subagents, dialogs

| Primitive                                                                          | Demonstrated by                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.generate` with a `schema`                                                     | `technical-support-agent` (five graders + rewriter), `research-planner-agent`, `executive-inbox-agent`. `travel-concierge-agent` deliberately uses none                                                                                                                                                           |
| `dialog()` + `dialog.tool` + `dialog.send`                                         | eight templates; see "A flow is WHERE A CONVERSATION IS" in `CLAUDE.md` for the reading order. A gated SLOT tool (`slot.updateTool({ dialog, when, send })`) is the common shape; `hotel-reception-agent` is the field form of `sendFrom`; `emergency-dispatch-agent` has tools with no `when`                    |
| `DialogStateSpec.onEnter`                                                          | the hang-up and the phase-change side effect (`executive-inbox-agent`, `hotel-reception-agent`): one declaration on the state, no `events.ts`                                                                                                                                                                     |
| `agent({ dialogs })` + `Dialog.receive` / `.timeout` / `.voiceConfig`, `AnyDialog` | `roadside-assistance-agent` (and `executive-inbox-agent`, for the hang-up)                                                                                                                                                                                                                                        |
| `procedure()`                                                                      | `technical-support-agent` — the CRAG loop inside one tool call, with `ctx.signal`                                                                                                                                                                                                                                 |
| `speaker()` + `ctx.delegate`                                                       | `topic-briefing-agent` (four subagents, `Promise.allSettled`, `stubDelegate`), `executive-inbox-agent`'s meeting assistant. Argued in `packages/aai-runtime/src/CLAUDE.md`, "Subagents"                                                                                                                           |
| `roster()` of off-line speakers + `delegate`                                       | `topic-briefing-agent`: name a subagent in code when the tool IS the choice; put it on the roster when the caller's words are                                                                                                                                                                                     |
| `SpeakerDef.expectedOutput`                                                        | all four of `topic-briefing-agent`'s; its spec asserts each declares one                                                                                                                                                                                                                                          |
| `SpeakerDef.guardrail`                                                             | `applicant-screening-agent`'s `emailWriter`, `executive-inbox-agent`'s meeting assistant, `research-planner-agent`'s executor. `topic-briefing-agent`'s `factChecker` moved to `schema` — reach for a guardrail only when a schema cannot say it                                                                  |
| `SpeakerDef.tools`                                                                 | `research-planner-agent`'s executor gets its own `search`/`read` over `@alexkroman1/aai/tools`, keeping `/tools` exercised                                                                                                                                                                                        |
| `stepDelegate`                                                                     | no template calls it directly any more (allowlisted): `research-handoff-agent`'s researcher moved into `deepResearchWorkflow` (`aai/src/sdk/deep-research.ts`), where `maxSteps` is the budget, the forced final answer the stop rule, `expectedOutput` the compression                                           |
| `deepResearchWorkflow` (`/experimental`)                                           | `research-handoff-agent`: overrides two prompts, keeps the default researcher and budget, and its `deliver` is the review wait plus filing; `home-assistant-agent`: overrides three prompts, swaps the researcher's builtins, and its `deliver` texts the report when asked, then says the summary on the speaker |
| `roster()` of `speaks: true` speakers + `Roster.handoff` + `HANDOFF_TOOL_NAME`     | `front-desk-agent` — three desks; code handoff, model routing, per-desk gating                                                                                                                                                                                                                                    |
| `mapSettled` + `partitionSettled`                                                  | `applicant-screening-agent` (`crews.ts`), `topic-briefing-agent` (`research_topic`)                                                                                                                                                                                                                               |
| `webSearch` / `visitWebpage`                                                       | `research-planner-agent` only, from an ordinary tool body                                                                                                                                                                                                                                                         |

### Workflows and steps

| Primitive                                                                                                                            | Demonstrated by                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow()` + `ctx.workflows` + `isTerminal`                                                                                        | `research-handoff-agent` (the handoff, its def from `deepResearchWorkflow`), `meeting-recap-agent`: the run is keyed by the session (`StartOptions.key` default), read back with `latest`/`live`, and spoken by the `workflow_status`/`workflow_progress`/`workflow_cancel` builtins through `describeRun`/`cancelNote`          |
| `ctx.waitForSignal` / `ctx.signalToken` / `ctx.workflows.signalRun`                                                                  | `meeting-recap-agent` (the retention gate), `outbound-call-agent`, `research-handoff-agent` (the review wait): no module holds a token string                                                                                                                                                                                    |
| `ctx.poll` + `ctx.report`                                                                                                            | `meeting-recap-agent`, `outbound-call-agent` (the ring), `podcast-digest-workflow`: every submit-then-check loop, with `first` for the callback arm                                                                                                                                                                              |
| `workflow({ … }).body(flow)` + `workflows/<name>.ts` discovery                                                                       | every workflow template: the def is the file's default export, the tools import it directly                                                                                                                                                                                                                                      |
| `ctx.sayOnClient` + `sayFailureOnClient`, `stepTextOwner`, `requireSessionClient` / `sessionClientId` / `sessionClientPhone`         | `home-assistant-agent` — a run that outlives the session reaches the speaker by its `?client=` id: a reminder after a durable `sleep`, a research summary from `deliver`, the failure from the engine's `onFailure`; the report is texted only when asked                                                                        |
| `mapConcurrent`, `stepEmit`, `stepEnv`/`requireStepEnv`, `stepGenerate`, `stepFetch`/`multipartBody`                                 | every workflow template, imported from `@alexkroman1/aai/step`                                                                                                                                                                                                                                                                   |
| `stepGenerateJson` + `stripJsonFence`                                                                                                | `link-digest-workflow`, `document-redline-workflow`, `meeting-recap-agent`; `stripJsonFence` only through `stepGenerateJson`                                                                                                                                                                                                     |
| `toStepError` / `throwStepError` / `throwFatalStepError`                                                                             | every workflow template                                                                                                                                                                                                                                                                                                          |
| `orFail(stepFetch)`                                                                                                                  | `link-digest-workflow`, `meeting-recap-agent`'s `request()`, `podcast-digest-workflow`'s `fetchText`. `meeting-recap-agent`'s DELETE stays on raw `stepFetch` (404 = already deleted)                                                                                                                                            |
| `transcribeUploadDurably`                                                                                                            | the transcribing templates that take the async API (`spoken-summary-workflow` is the reference); the budget refusal names the transcript id                                                                                                                                                                                      |
| `stepTranscribeUpload` / `Submit` / `Poll`, `stepTranscribeSync`                                                                     | `transcription-workflow` — the sync fan-out the composition does not fit (`batch.ts`, `sync-api.ts`)                                                                                                                                                                                                                             |
| `stepSpeakToUpload` + `WorkflowApi.download`                                                                                         | `spoken-summary-workflow` only; `stepSpeak` + `stepWriteUpload` underneath                                                                                                                                                                                                                                                       |
| `transcodeUpload`                                                                                                                    | `call-audit-workflow`, `transcription-workflow`'s `normalize.ts` — the materialize → ffmpeg → store shell as one step result                                                                                                                                                                                                     |
| `runFfmpeg` / `probeMedia` / `wavEncodeArgs`                                                                                         | `call-audit-workflow` (argv built by pure functions in `workflows/media.ts`). See `FFMPEG-CLAUDE.md`                                                                                                                                                                                                                             |
| `encodeWav` + `pcmDurationMs`                                                                                                        | `call-audit-workflow`, `transcription-workflow`                                                                                                                                                                                                                                                                                  |
| `throwFfmpegStepError`                                                                                                               | `call-audit-workflow`, `transcription-workflow`. `isFfmpegError`/`FfmpegError` are allowlisted: the SDK classifies structurally                                                                                                                                                                                                  |
| `withTempDir` / `readUploadToFile` / `writeUploadFromFile`                                                                           | `call-audit-workflow`, `transcription-workflow`                                                                                                                                                                                                                                                                                  |
| `ASSEMBLYAI_TTS_VOICES`, `ASSEMBLYAI_TTS_DEFAULT_VOICE`                                                                              | `spoken-summary-workflow`, `call-audit-workflow`; the default voice also in `custom-pipeline-agent`                                                                                                                                                                                                                              |
| `slack` / `sendToChannel`                                                                                                            | `podcast-digest-workflow`; `workflows/slack.ts` keeps only the digest as a `ChannelMessage`. `isSlackWebhookUrl` refines `agent.ts`'s schema                                                                                                                                                                                     |
| `WorkflowInputOf` / `WorkflowRunOf` / `lastLine`                                                                                     | `podcast-digest-workflow`, `call-audit-workflow`, `spoken-summary-workflow` (input type, through the two-phase def); `research-handoff-agent`, `meeting-recap-agent` (the other two)                                                                                                                                             |
| `fatalOn` / `orFatal`                                                                                                                | `transcription-workflow` (a WAV the cutter cannot read is fatal on the first attempt), `call-audit-workflow`                                                                                                                                                                                                                     |
| `StepOptions.maxWaits`                                                                                                               | every fan-out that meets a rate limit — the attempts stay three; `transcription-workflow`                                                                                                                                                                                                                                        |
| `formatBytes` / `formatDuration` / `countWords` / `plural`                                                                           | seven templates on both sides of the bundle boundary, so a step's report and the page agree                                                                                                                                                                                                                                      |
| `decodeHtmlEntities`                                                                                                                 | `medication-safety-agent`, `podcast-digest-workflow` (as `decodeXml`). Tag stripping did not move                                                                                                                                                                                                                                |
| `stepPlaceCall({ brief })` / `stepCallStatus` / `isCallOver` / `PlaceCallError`                                                      | `outbound-call-agent` only (`workflows/call.ts`): dial with the brief signed by the SDK, poll the ring with `ctx.poll`, then park on `ctx.waitForSignal`; a non-retryable `PlaceCallError` becomes a `failed` outcome, not a failed run. Specs: `stubPlaceCall`                                                                  |
| `apiKeyRoute` + `routeError` / `routeResponse`, `sessionContext` `{ refuse, instructions, greeting }`, `onSessionEnd` + `transcript` | `outbound-call-agent`: `/api/v1/calls` behind `CALLS_API_KEY`; the session reads the brief with `sessionCall(ctx).brief(secret)` and refuses an unsigned stream; `onSessionEnd`'s `transcript` is how the call went. Its page is the one voice-agent `mountPage()` (`PHONE_ONLY_TEMPLATES` in `src/template-page-mount.test.ts`) |

### Clients

| Primitive                                                                                   | Demonstrated by                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useAgentState(projection)`                                                                 | eight templates passing the projection itself; `entertainment-picks-agent` also shows a slot beside `useEvent`/`useToolCallStart` (rule in `packages/aai-ui/CLAUDE.md`)                                                                                   |
| `useAgentState("slot", fallback)`                                                           | `retail-orders-agent`, `hotel-reception-agent` — importing the slot would ship their seeds (107 KB / 18.5 KB) to the browser; the fallback is the slot's `empty` frame, projected in the client                                                           |
| `mountClient({ theme: { primary, mode }, css })`                                            | every themed page; the four neutrals are derived, and a chrome's `@keyframes` or scrollbar palette is `css`, not a `<style>` element                                                                                                                      |
| `AutoScroll`, `useUserTranscript`, `SessionStateDot`, `SessionControls`, `ConversationView` | the three custom chromes: `emergency-dispatch-agent`, `retail-orders-agent`, `text-adventure-agent` (`SessionControls`'s Start branch unused there by design); the dot takes its palette from the theme. `useSessionControls`: `push-to-talk-agent` alone |
| `SessionErrorBanner` + `AGENT_STATE_LABELS` + `useSessionStatus`                            | `text-adventure-agent`, `retail-orders-agent`; the dot now calls the latter two, so their direct exercisers are gone                                                                                                                                      |
| `ToolCallRow variant="compact"`                                                             | `emergency-dispatch-agent`, `retail-orders-agent`; `text-adventure-agent` deliberately keeps its bracket line                                                                                                                                             |
| `useInbox` + `useTapToTalk` + `useConversationLog`, `mountClient({ client: "auto" })`       | `home-assistant-agent` — a page that IS a speaker: tap to talk, the inbox held open so a reminder plays with no session, a `stop` client event that silences it                                                                                           |
| `mountPage()` + `useWorkflowSubmit<typeof agentDef>("name")`                                | every workflow-app page — the name is a checked literal, no `WORKFLOW` constant; `link-digest-workflow` is the hand-written form over raw primitives                                                                                                      |
| `Form` + `WorkflowFields` + `useWorkflowSubmit`, `useWorkflowRun`                           | `transcription-workflow` — all-declared form, no field markup; `submission.timing` is its press-to-transcript clock                                                                                                                                       |
| `<WorkflowFields render={{ … }}>` (`lines` / `namedText`)                                   | `document-redline-workflow` — a `string[]` and a `{ name, text }` draft rendered by the declared form ("Forms" in `packages/aai-ui/src/components/CLAUDE.md`)                                                                                             |
| `WorkflowProgress`, `WORKFLOW_STATUS_LABELS`                                                | `transcription-workflow`, `document-redline-workflow` (whole narration); `link-digest-workflow`, `podcast-digest-workflow` (`lines={1}`)                                                                                                                  |
| `WorkflowRunPanel`                                                                          | `document-redline-workflow`, `transcription-workflow` (`live={<LiveTranscript>}`)                                                                                                                                                                         |
| `WorkflowPendingNote` + `WorkflowRunError`                                                  | the six workflow-app pages; `transcription-workflow` keeps `recover.ts` because its streaming mode has a fourth branch (a reload ENDS the run)                                                                                                            |
| `useDownloadUrl`, `AudioResult`                                                             | `spoken-summary-workflow` (passes `captions`), `call-audit-workflow` (omits it; text rendered in full)                                                                                                                                                    |
| `.aai-scroll`, `--aai-scrollbar-thumb`, `aai-pulse`                                         | the four chromes; a pulsing WORD uses Tailwind's `animate-pulse`, since `aai-pulse` also scales                                                                                                                                                           |

### Testing helpers

| Primitive                                                                | Demonstrated by                                                                                                                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createToolContext`                                                      | `emergency-dispatch-agent`, `pizza-ordering-agent`, `retail-orders-agent`, `tabletop-rpg-agent`; `{ turn, now }` pins the clock and the turn                                                  |
| `describeAgent` + `run(toolDef, args)`                                   | every unit spec: the deployable case built in, the runner typed by the tool's own default export — no per-spec wrapper, no restated result schema                                             |
| `expectSlotContract`                                                     | every stateful spec — the projected default, session isolation and caps in one call                                                                                                           |
| `sessionEvent` / `fireEvent`                                             | every spec that drives an `events` handler (`hotel-reception-agent`, `travel-concierge-agent`, `emergency-dispatch-agent`)                                                                    |
| `expectToolOk` / `expectDialogOk`, `parseToolInput` / `parseSchemaInput` | result unwraps (`expectToolOk` takes plain tools too); fail at the call instead of three assertions later                                                                                     |
| `expectDialogRefused` / `dialogRefusalPattern`                           | that a gate HELD; never pin the refusal sentence by regex. `applicant-screening-agent`'s unit spec; evals take `dialogRefusalPattern(state)`                                                  |
| `deployedAgent`                                                          | `retail-orders-agent/registry.test.ts` only; every other spec imports `virtual:aai/agent` (served by `aaiAgentPlugin()` in `vitest.config.ts`)                                                |
| `stubGenerate`, `createToolContext` scripts, `runGuardrail`              | `technical-support-agent`, `research-planner-agent`, `executive-inbox-agent`, `applicant-screening-agent`                                                                                     |
| `stubStepDelegate` / `installStubStepDelegate`                           | `research-handoff-agent`, both tiers — the unpublished slot THROWS                                                                                                                            |
| `installStubStepFetch`, `stubStepFetch`                                  | every workflow spec — never stub `globalThis.fetch`, which tests a fallback production never takes                                                                                            |
| `installStubWorld`                                                       | every workflow spec and eval: the gateway, pages, transcription, speech and uploads composed in the one order that works, and `ASSEMBLYAI_API_KEY` seeded (no `vi.stubEnv`)                   |
| `installStubGateway`                                                     | `research-handoff-agent`, `link-digest-workflow`, `document-redline-workflow` (bare `stubGateway` is allowlisted); `apiKey: false` only in the missing-key spec                               |
| `stubTranscribe`                                                         | the three transcribing templates                                                                                                                                                              |
| `stubSpeech` + `stubUploads(…, { writable: true })`                      | `spoken-summary-workflow`                                                                                                                                                                     |
| `installStubClientInbox` + `installStubSpeech`                           | `home-assistant-agent` — what a `sayOnClient` step pushed, and a `busy` client failing the attempt as retryable                                                                               |
| `createRunSnapshot(def)`, `installStubWorkflows({ agent })`              | `research-handoff-agent`, `meeting-recap-agent` — names derived from the def and the agent, never restated                                                                                    |
| `describeEval(…, { steps })` + `evalRunOf`                               | the hand-off evals (`research-handoff-agent`, `meeting-recap-agent`): the harness holds the first step request and drains the run; the run id is read off the session's record                |
| `toolResultIn(calls, toolDef)` / `lastStateIn(events, slot.projected)`   | every eval reading a result or a frame — typed by the def and the projection, no `Projected*` schema                                                                                          |
| `runWorkflow(agentDef, "name", input)`                                   | every durability block — the name checked against the agent                                                                                                                                   |
| `expectDeployable`                                                       | the four starters plus `medication-safety-agent`; it returns the resolved config. When it is the test's only claim, wrap it in `expect(…).not.toThrow()` — the assertion gate counts `expect` |
| `expectPromptBuiltinsDeclared`                                           | `code-interpreter-agent`, `medication-safety-agent`, `web-research-agent`; fails on a prompt naming no builtin                                                                                |
| `runCodeIn` + `runCodeOutput`                                            | `code-interpreter-agent`, `entertainment-picks-agent` (`packages/aai-runtime/TEXT-AGENT-CLAUDE.md`)                                                                                           |
| `expectToolBeforeSpeech` + `EvalTurn.errors` / `errorsIn`                | `code-interpreter-agent`, `web-research-agent` (ordering); `quickstart-agent`, `custom-pipeline-agent` (errors)                                                                               |

## Dialog templates

Reading order for flows: `travel-concierge-agent` (two states, one gate),
`research-planner-agent` (a lifecycle), `retail-orders-agent` (terminal state,
nested confirmation gate), `tabletop-rpg-agent` (nested, plus `final`),
`emergency-dispatch-agent` (a board — see below), `roadside-assistance-agent`
(what a dialog does when no tool runs).

- **`emergency-dispatch-agent`** holds many incidents, and a flow has one
  position per session, so `working.monitoring` means "the incident last touched
  has units", never "every incident does". Its six gated tools gate on the
  PARENT state (has anything been logged this shift); the children carry the
  instruction.
- **`roadside-assistance-agent`**:
  `on: { "@userTranscript.committed": "locating" }` on the state itself is the
  silence ladder (re-arms on every committed turn); `onCall.verifying` declares
  no chatter transition, so its deadline is wall clock. `onCall.quiet` is the
  ladder's landing rung (a shorter question). `service_disclosure` hands over
  the words and `acknowledge_disclosure` advances a turn later, so the
  disclosure is spoken under `interruption: "off"`. `toolChoice` is pinned on
  `onCall.dispatching`, not on `verifying`; `dispatch_truck` is idempotent. The
  hang-up (`@session.timedOut` → final `abandoned`) is declared once on the
  `onCall` parent. `agent.test.ts` asserts no state declares `voice`/`keyterms`.
- **`retail-orders-agent`**: the seven changing tools are STAGERS writing a
  `PendingAction`; `confirm_change` is the only store writer, gated on
  `serving.awaitingConfirmation`; `cancel_change` drops unconditionally.
  `IDENTIFIED` is not handled on `serving`, since that self-transition would
  re-enter and strand the pending change. Plans hold ids and amounts, not store
  references, so a persisted session can carry them. `registry.test.ts` pins
  seventeen tool names. The activity feed is written by `tool.called` and
  `tool.completed`, so a gated refusal is on it too.
- **`tabletop-rpg-agent`**: `gameOver` is `final`; `setup_character` declares
  `reset: true`. The `after` hook owns `gameOver`/`inCrisis` and the tools that
  speak them `report` off the stored value.
- **`research-planner-agent`**: `start_plan` and `revise_plan` are the `prepare`
  shape — the model call first, then the synchronous window; `work_next_step`
  keeps claim-then-await and takes `sendFrom` as the second argument.
- **`word-game-agent`**: `playing` declares no transition except its two exits,
  and its three in-round tools send nothing, so the round timer is not re-armed.

## `research-handoff-agent`

The voice-to-workflow handoff, and the worked example of `deepResearchWorkflow`
(`@alexkroman1/aai/experimental`). The declaration is the default export of its
`workflows/` file, registered by discovery and imported by the tools directly;
the desk's `deliver` is the named review wait, then `file`;
`workflows/prompts.ts` holds the two prompts it overrides (the phone brief and
the phone summary).

The pass is five stages adapted from LangChain's `open_deep_research` (MIT;
attribution and stage mapping in `aai/src/sdk/deep-research-prompts.ts`):
`writeBrief`, `planAngles` (fan-out width from this step's journaled result),
`investigate` (one `stepDelegate` researcher per angle), `findGaps`,
`investigateGap`, `writeReport` (report plus summary in ONE step). The step
names are the ones this template journaled under before the move. The loop's
budget is `maxSteps`, not the prompt; the loop is journaled as ONE step result;
the compression prompt says to REPEAT relevant text rather than summarize. The
stage-level specs live in `sdk/deep-research.test.ts`.

Spec tiers: tools against stubbed `ctx.workflows`; the desk's configuration and
delivery via `createWorkflowContext`; the whole run via `runWorkflow` on the
real replay engine. `aai-cli`'s `dev-workflow.scenario.test.ts` is the tier
above.

## `transcription-workflow`

A `workflowApp()` (no `stt`/`llm`/`tts`, no tools) against AssemblyAI's SYNC
endpoint: `splitRecording` → `transcribeSegment` per chunk (fan-out forced by
the endpoint's 120 s / 40 MB cap) → `mergeTranscript`. A run that dies on
segment 27 resumes having replayed 1–26.

- The recording is UPLOADED (`uploads: ["recording"]`); each step reads its
  window with `stepReadUpload`. The template contains no upload code. The page
  shows `<UploadProgressBar>` and `<WorkflowProgress>` (two disjoint waits) and
  one press-to-transcript clock (`<TotalLatency>` in `run-panel.tsx`, read off
  `submission.timing`), because `output.elapsedMs` misses the upload.
- Linear-PCM WAV only, named in the error with the `ffmpeg` line that fixes it;
  `workflows/wav.ts` is pure functions over journaled values.
- Segments overlap by two seconds; `stitchTranscript` drops the longest repeated
  run at each seam on a punctuation-stripped key (a missed seam repeats words; a
  false one deletes speech).
- `SEGMENT_CONCURRENCY`'s doc carries the concurrency measurements.
- `batch.ts` is one `transcribeUploadDurably` call: the async leg's three steps
  and durable poll are the SDK's, so the flow is the comparison baseline.
- Its spec drives only `transcribeBatch` durably; the two ffmpeg flows'
  durability is the scenario tier's. No template covers the webhook waitpoint;
  `dev-workflow.scenario.test.ts` does.

## `meeting-recap-agent` — the Temporal ports

`research-handoff-agent`'s shape carrying the Temporal TypeScript samples that
translate, against the real BATCH API (`transcription-workflow` takes the sync
endpoint, this one the job-id-and-poll endpoint). Both files carry the mapping.

| Temporal sample                           | Ported as                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `saga` (`openAccount`)                    | `recapFlow`'s compensation stack, unwound by `compensate`                             |
| `polling` (infrequent)                    | `ctx.poll` — a journaled check plus a durable sleep per round, bounded by `maxMs`     |
| `timer-examples` (`processOrderWorkflow`) | the `Promise.race` against `PATIENCE`, then the "still going" note                    |
| `expense` (`timeoutOrUserAction`)         | the retention gate: `ctx.waitFor(token, { timeoutMs })`, three outcomes, safe default |
| `signals-queries` (Signal)                | `keep_transcript`, over `ctx.workflows.signal`                                        |
| `signals-queries` (Query + Cancellation)  | `recap_status` and `cancel_recap`                                                     |
| workflow-id reuse / `mutex`               | the live-run check in `request_recap`                                                 |

- `SAMPLE_RECORDING` is the provider's public sample, because a caller cannot
  read a URL aloud; the tool still accepts one.
- The signal is `ctx.waitForSignal` in the body and `ctx.workflows.signalRun` in
  the tool; nothing derives a token.
- Cancellation is NOT cooperative here: `ctx.workflows.cancel` stops replay, so
  compensations do not run and the transcript stays. The def's `cancelNote` says
  so, and the spec pins the sentence. The template stops at one hook on purpose.
- The poll's `value` is the status the saga and the status tool read.
- Spec tiers: tools, steps, body helpers against `createWorkflowContext`
  (ordering and branching only), and `recapFlow` on the real replay engine for
  "a resume does not re-transcribe" and "the unanswered window deletes" —
  `run.expireWaits()` is the only route to that branch.
