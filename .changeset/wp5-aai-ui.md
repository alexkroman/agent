---
"@alexkroman1/aai-ui": major
---

**Breaking: `SessionCoreOptions` is removed.** It was an exact alias of
`VoiceSessionOptions` with a single referent — `createSessionCore`'s parameter,
which now names `VoiceSessionOptions` directly — and `client()` never took it.
Replace `SessionCoreOptions` with `VoiceSessionOptions`; nothing else changes.

`fetchClientConfig` is now public and part of the `page` capability. A workflow
app mounted with `page()` makes no `GET client-config` request of its own, so
this is how a page reads the agent's declared `name` and `greeting` — which two
published doc comments already told authors to do while the function was
`@internal` and absent from the reference.

`SubmitButton` accepts `variant` and every `<button>` attribute except `type`
and `disabled` (which it owns, setting both from `pending`). It was the only
form control taking neither, so `aria-label` on an icon-only submit was a type
error on the one button a workflow-app form has.

`Markdown`, `Controls` and `MessageList` now name their props —
`MarkdownProps`, `ControlsProps`, `MessageListProps` — so a wrapper can forward
them without restating the shape, and so the published reference describes them
at all: all three previously rendered as `MemoExoticComponent` with no props,
leaving `Markdown`'s required `text` named nowhere.

Documentation, throughout: component props are documented on the properties
rather than in `@param` tags that TypeDoc discarded (eighteen components,
including `AutoScroll`'s bounded-height requirement and `WorkflowProgress`'s
`className`-replaces-the-default rule); every `SessionSnapshot` field and every
`AgentState` member carries prose, `userTranscript`'s `null`-vs-`""` distinction
included; `useWorkflowRun`, `useToolResult`, `useToolCallStart`, `useTheme`,
`useSessionSelector`, `useWorkflows`, `createWorkflowApi`, `Field`,
`SubmitButton`, `Markdown` and `ToolCallRow` gained examples; the two
`useToolResult` / `useToolCallStart` overloads have their own descriptions
instead of sharing one that said "optionally filter by tool name" on the
overload taking no tool name; `WorkflowSubmission` and `WorkflowStreamSubmission`
cross-reference each other and name the two fields that actually differ; and the
README no longer tells readers to call `session.connect()`, which `Session` does
not have.
