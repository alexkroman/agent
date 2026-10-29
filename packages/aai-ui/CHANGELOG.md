# @alexkroman1/aai-ui

## 0.18.0

### Minor Changes

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
- f40ff5e: ThemeProvider restores the page from one shared snapshot when the last live
  provider unmounts, so two clients disposed in mount order no longer leave the
  first one's theme tokens on :root.
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

- 1418d62: Give the browser client's published types a direction, so they can grow without
  breaking pages:
  
  - Every hook result, handle and snapshot is now `@sealed`, and every props and
    options type `@input`.
  - The literal sets a page receives are open (`| (string & {})`): `AgentState`,
    `ChatMessage.role`, `ToolCallInfo.status`, `WorkflowFieldKind`,
    `SessionControlAction` and `UseTapToTalkResult.phase`. A `switch` over one
    needs a `default`, and `AGENT_STATE_LABELS[state]` needs a fallback.
  - `ConversationItem` gains `{ kind: "other"; type }` (an item a newer page
    stored in the conversation log, kept rather than discarding its session) and
    `InboxEvent` gains `{ type: "other"; frameType }` (a frame type this version
    does not know).
  - `<SessionStateDot colors>` is an optional partial palette; unnamed states take
    the theme colour `ConsoleShell` uses, and an unknown state is labelled with
    its raw value.
  - `useTheme()` returns the new `ResolvedClientTheme` instead of
    `Required<ClientTheme>`.
  - `fetchClientConfig()` takes an options object `{ platformUrl, fetch, signal }`
    instead of positional arguments.
  - `UseWorkflowStreamOptions` is declared on its own rather than derived from
    `UseWorkflowSubmitOptions`.
  - The upload and download names move to a new `aai-ui:workflow-files`
    capability.

### Patch Changes

- 1262e21: Add `isFileValue(value)`, the guard a page narrows a `<FileField>`'s entry in
  `FormValues` with instead of casting it to `FileValue`. Tag `ControlsProps`,
  `MarkdownProps` and `MessageListProps` `@input`.
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

- d6bf377: Change the default client theme to a neutral palette (near-white background,
  zinc borders, near-black primary) so an unthemed agent no longer looks like the
  studio's own cream-and-indigo chrome when previewed inside it. Pass
  `mountClient({ theme })` to keep the previous colors.
  
  The default fonts are now the platform's system UI and monospace faces instead
  of Monument Grotesk and JetBrains Mono, and the start-screen and console-shell
  titles are a semibold sans instead of a serif. The `font-aai-serif` token stays
  for clients that opt into it.
- effb401: `StartScreen`, `ConsoleShell` and `ChatView` no longer draw the AssemblyAI logo
  when no `icon` is passed, so an unthemed agent carries no vendor branding.
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

- Updated dependencies [d66b0c3]
  - @alexkroman1/aai@0.14.2

## 0.14.1

### Patch Changes

- 7554cd0: A session hung up before its pre-connect capture opened no longer opens the
  microphone at all, instead of opening it and closing it straight after
- @alexkroman1/aai@0.14.1

## 0.14.0

### Patch Changes

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
