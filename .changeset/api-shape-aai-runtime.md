---
"@alexkroman1/aai-runtime": minor
"aai-server": patch
---

Reshape `@alexkroman1/aai-runtime`'s published surface so it stops producing
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
