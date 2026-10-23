# @alexkroman1/aai-ui

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
