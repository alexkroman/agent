---
"@alexkroman1/aai": minor
"aai-server": patch
---

Simplify the agent authoring surface, and move every template onto it.

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
