# @alexkroman1/aai-runtime

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
