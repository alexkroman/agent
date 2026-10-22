---
"@alexkroman1/aai-ui": minor
---

Give the browser client's published types a direction, so they can grow without
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
