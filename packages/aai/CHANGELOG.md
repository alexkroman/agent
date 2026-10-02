# @alexkroman1/aai

## 0.14.1

No changes in this release.

## 0.14.0

### Minor Changes

- 99400e3: BREAKING (testing API): fold routeStepFetch, StepRoute and StepUnmatched into
  stubFetchRoutes — pass it the list of legs (a model's stubGatewayRoute().route
  first), with the new globalFetch: false option to route only the step fetch.
  Remove installFetchRoutes (use stubFetchRoutes plus onTestFinished(net.restore))
  and createProgressStream (use ReadableStream.from). commandedBuiltins is no
  longer exported; expectPromptBuiltinsDeclared returns the same list.

### Patch Changes

- 5fa348b: Pay down debt-report ledgers: share the cause-chain walk, the runtime-file copy
  and the tool-message list normalizer; drop four `as never` casts behind typed
  seams
- f6aa687: `defineAgentTestConfig()` now sets `restoreMocks`, `unstubEnvs` and
  `unstubGlobals`, so a scaffolded project's specs no longer leak a `vi.spyOn`,
  `vi.stubEnv` or `vi.stubGlobal` into the next test. Pass
  `test: { unstubGlobals: false }` (or any of the three) to opt out.
- 67f7354: `ProjectFiles.tools` (on `@alexkroman1/aai/testing`) spells out its type,
  `Readonly<Record<string, unknown>>`, instead of naming `ToolModules`, a type no
  testing capability owned. The type is the same, so nothing that compiled before
  stops compiling.
- 8820f2c: Replace truthiness-guarded conditional spreads with explicit presence checks
  (omitUndefined, != null, === true), so an empty-string body forwarded to a guest
  is no longer dropped; guard-invariants rule 22 is now enforced at zero.
- f869b6a: Use the shared isRecord guard in standard-schema issue paths and the eval
  partial matcher
- 5fa348b: Give every module a co-located test and remove every vi.mock: collaborators the
  specs used to mock by module are now optional injected seams that default to the
  real implementation
- 5ded42b: Test-only: the procedure spec's actor honours its abort signal; no runtime
  change.
- 99400e3: Internal: the /testing fakes share one scripted gateway, script router, schema
  check, step-fetch recorder and recording slot. No signature or behaviour change.

## 0.13.0

### Minor Changes

- The first `0.x` release. Versions 1.0.0 through 18.0.0 were pre-release history and are not carried forward; this line restarts at 0.13.0, the lowest `0.x` not already on the registry. During `0.x` a breaking change is a minor bump.
- Every deprecated API is removed: `createRuntimeServer` (use `createServerForRuntime`), `AgentInstructions` (`Exclude<AgentSystemPrompt, string>`), `StaticAgentParams` (`WorkflowAppAgentParams`), `scriptedToolContext` and its two types (`createToolContext` takes the `generate`/`delegate` scripts and exposes `ctx.model`/`ctx.desk`), `SessionSlot.projection(view)` (declare `sessionSlot(key, create, { view })` and pass `slot.projected`), the record form of `agent({ syncState })` (pass a projection or a list), and `aai test --all` (now a usage error).
- Every legacy fallback is removed: `session.configured.sessionId` is required and `?resume=1` is gone, the platform base URL is read only from `AAI_PLATFORM_BASE_URL`, and a configuration with no stages is S2S only with an explicit `s2s` descriptor.
- Every API contract epoch restarts at 1.
