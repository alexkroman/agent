# @alexkroman1/aai-runtime

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
