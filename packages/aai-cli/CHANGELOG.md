# @alexkroman1/aai-cli

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
