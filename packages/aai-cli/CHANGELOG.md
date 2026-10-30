# @alexkroman1/aai-cli

## 0.19.0

### Patch Changes

- Updated dependencies [efaadfb]
- Updated dependencies [ac622a2]
- Updated dependencies [c849604]
- Updated dependencies [cad7bf8]
- Updated dependencies [5ec6afc]
- Updated dependencies [2dbf3c0]
- Updated dependencies [fa16f3d]
- Updated dependencies [de5f82a]
  - @alexkroman1/aai-runtime@0.19.0
  - @alexkroman1/aai@0.19.0
  - @alexkroman1/aai-ui@0.19.0

## 0.18.2

### Patch Changes

- Updated dependencies [502507c]
  - @alexkroman1/aai-runtime@0.18.2
  - @alexkroman1/aai@0.18.2
  - @alexkroman1/aai-ui@0.18.2

## 0.18.1

### Patch Changes

- Updated dependencies [dea550d]
  - @alexkroman1/aai-runtime@0.18.1
  - @alexkroman1/aai@0.18.1
  - @alexkroman1/aai-ui@0.18.1

## 0.18.0

### Minor Changes

- c6ae3fd: Harden the `aai` CLI against hostile servers, cloned repos and odd argv, after
  an adversarial test pass.
  
  - `aai publish` now syncs only the values written in the project's dotenv files.
    It no longer fills declared keys from your shell, and it refuses a symlinked
    `.env` that points outside the project.
  - `aai pull` no longer writes `.git/`, `.aai/`, `.env`, lockfiles or
    `node_modules/`. It never writes through a symlink and checks the whole file
    map before writing anything.
  - API requests no longer follow redirects. They also have a timeout and a
    response size cap.
  - Text from the server or agent can no longer send terminal escape sequences.
  - `aai delete` asks for confirmation at a terminal and needs `--yes` otherwise.
  - Bare `aai` with piped stdout no longer publishes.
  - `--server` must be a non-empty http(s) URL.
  - `-v` after a subcommand prints the version instead of running the command.
  - Extra positional arguments and non-decimal numbers are now refused.
  - In JSON mode, `aai dev`, `aai test`, `aai eval` and `aai build` keep their
    logs off stdout.
  - A broken pipe no longer turns a failure into exit code 0.
- af9fb16: aai start --workers N serves one build from N processes: client-affinity routing
  (no database required; DATABASE_URL adds crash survival), primary-owned
  lifecycle with drain (--drain-timeout), SIGHUP rolling restart and per-worker
  admission (--max-calls-per-worker). Runtime: per-frame hot paths memoized,
  provider frames sent in one TLS write per tick, model-provider connections kept
  alive 30 s across turns, pooled event-id randomness and a TTS audio fast path.

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
- afc85c6: Templates: a new `front-door-agent` template — a smart door and the owner's
  phone on one page. A phone links by a spoken code (`mintDigitCode`, `hashCode`,
  `createLinkedClient`, `useRouteMutation`), visitors' messages and a signed
  hardware ring (`webhookRoute`) reach it through `stepNotifyClient`, it watches
  the door live with `useInbox` + `inboxEventToItem`, and a daily digest reads the
  door's log with `stepClientTranscript`.
- afc85c6: Templates: a new `kitchen-coach-agent` template (client tools the page answers
  with `useClientTool`, a kitchen form of `aai-ui` fields remembered with
  `useStoredValue`, `StartScreen` + `SidebarLayout` + `ChatView`, and a history
  route over `ctx.clientTranscript`); `home-assistant-agent` gains a "Coming up"
  panel over `clientRunsRoutes` + `useClientRuns`; `outbound-call-agent`'s page
  uses `TextField`, `TextAreaField`, `useStoredValue` and `phoneE164`.
- ac38a37: A deployed worker carries only the speech SDKs its agent declares. The worker is
  one file, so every vendor STT/TTS opener the runtime loads lazily was inlined
  regardless: the quickstart's worker was 9.8 MB, 42% of it the ElevenLabs SDK,
  for an agent on the default AssemblyAI pipeline. aai build and aai deploy now
  read the agent's own config and leave out the vendors it cannot reach; a stub
  throws, naming what was left out, only if a runtime is handed such a provider
  anyway.
- 1f6553d: The starter templates now mark their 34 write tools — bookings, orders,
  cancellations, dispatches, sent messages, incident and ticket records — with
  `effect: "write"`, so a caller's "uh-huh" spoken over the agent's confirmation
  question cannot trigger one. Lookups, cart and draft steps that a later tool
  commits, and internal notes stay unmarked.
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
- Updated dependencies [f40ff5e]
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
  - @alexkroman1/aai-ui@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [a8a37ac]
- Updated dependencies [eb14ffe]
- Updated dependencies [1418d62]
- Updated dependencies [b1d73be]
- Updated dependencies [1262e21]
- Updated dependencies [8f93cca]
- Updated dependencies [130bc0c]
  - @alexkroman1/aai@0.17.0
  - @alexkroman1/aai-runtime@0.17.0
  - @alexkroman1/aai-ui@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [06d09d5]
  - @alexkroman1/aai@0.16.0
  - @alexkroman1/aai-runtime@0.16.0
  - @alexkroman1/aai-ui@0.16.0

## 0.15.5

### Patch Changes

- 3bada25: Template fixes from a live eval run: `meeting-recap-agent` no longer cancels and
  restarts a running recap (which paid for a second transcription),
  `executive-inbox-agent` says `edit` sends and keeps it for real changes to the
  draft, and the pizza, quickstart, topic-briefing and tabletop RPG prompts cover
  cases they left ambiguous.
- @alexkroman1/aai@0.15.5
  - @alexkroman1/aai-runtime@0.15.5
  - @alexkroman1/aai-ui@0.15.5

## 0.15.4

### Patch Changes

- Updated dependencies [d6bf377]
- Updated dependencies [effb401]
  - @alexkroman1/aai-ui@0.15.4
  - @alexkroman1/aai@0.15.4
  - @alexkroman1/aai-runtime@0.15.4

## 0.15.3

### Patch Changes

- Updated dependencies [4a291dd]
  - @alexkroman1/aai@0.15.3
  - @alexkroman1/aai-runtime@0.15.3
  - @alexkroman1/aai-ui@0.15.3

## 0.15.2

### Patch Changes

- d02864f: Outbound Caller template: keep the API key label on one line instead of stacking
  the `CALLS_API_KEY` code and closing parenthesis as separate column items.
- @alexkroman1/aai@0.15.2
  - @alexkroman1/aai-runtime@0.15.2
  - @alexkroman1/aai-ui@0.15.2

## 0.15.1

### Patch Changes

- Updated dependencies [89737d1]
- Updated dependencies [9ed592e]
  - @alexkroman1/aai-runtime@0.15.1
  - @alexkroman1/aai-ui@0.15.1
  - @alexkroman1/aai@0.15.1

## 0.15.0

### Patch Changes

- Updated dependencies [851a4ab]
  - @alexkroman1/aai@0.15.0
  - @alexkroman1/aai-runtime@0.15.0
  - @alexkroman1/aai-ui@0.15.0

## 0.14.4

### Patch Changes

- Updated dependencies [d266c27]
  - @alexkroman1/aai@0.14.4
  - @alexkroman1/aai-runtime@0.14.4
  - @alexkroman1/aai-ui@0.14.4

## 0.14.3

### Patch Changes

- f02133e: Add the outbound-call-agent template: an HTTP API (POST /api/v1/calls) and
  console page that place phone calls with stepPlaceCall, carry out a task on
  each, and return the transcript, summary and outcome.
- f02133e: `aai dev --tunnel` now works for agents with a `client.tsx`: the tunnel's
  hostname is added to Vite's `server.allowedHosts`, so requests through it (the
  page, the API, and webhooks such as Twilio's) are no longer refused with
  "Blocked request. This host is not allowed."
- Updated dependencies [d648b81]
  - @alexkroman1/aai@0.14.3
  - @alexkroman1/aai-runtime@0.14.3
  - @alexkroman1/aai-ui@0.14.3

## 0.14.2

### Patch Changes

- Updated dependencies [d66b0c3]
- Updated dependencies [f7c51dc]
  - @alexkroman1/aai@0.14.2
  - @alexkroman1/aai-runtime@0.14.2
  - @alexkroman1/aai-ui@0.14.2

## 0.14.1

### Patch Changes

- Updated dependencies [7554cd0]
  - @alexkroman1/aai-ui@0.14.1
  - @alexkroman1/aai@0.14.1
  - @alexkroman1/aai-runtime@0.14.1

## 0.14.0

### Patch Changes

- 382c1de: Template example tests read their fetch stubs from `vi.fn` call records and
  narrow with `assert`.
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
  - @alexkroman1/aai-ui@0.14.0

## 0.13.0

### Minor Changes

- The first `0.x` release. Versions 1.0.0 through 18.0.0 were pre-release history and are not carried forward; this line restarts at 0.13.0, the lowest `0.x` not already on the registry. During `0.x` a breaking change is a minor bump.
- Every deprecated API is removed: `createRuntimeServer` (use `createServerForRuntime`), `AgentInstructions` (`Exclude<AgentSystemPrompt, string>`), `StaticAgentParams` (`WorkflowAppAgentParams`), `scriptedToolContext` and its two types (`createToolContext` takes the `generate`/`delegate` scripts and exposes `ctx.model`/`ctx.desk`), `SessionSlot.projection(view)` (declare `sessionSlot(key, create, { view })` and pass `slot.projected`), the record form of `agent({ syncState })` (pass a projection or a list), and `aai test --all` (now a usage error).
- Every legacy fallback is removed: `session.configured.sessionId` is required and `?resume=1` is gone, the platform base URL is read only from `AAI_PLATFORM_BASE_URL`, and a configuration with no stages is S2S only with an explicit `s2s` descriptor.
- Every API contract epoch restarts at 1.
