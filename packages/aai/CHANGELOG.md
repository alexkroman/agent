# @alexkroman1/aai

## 0.15.3

### Patch Changes

- 4a291dd: Studio packages reuse shared SDK helpers (runCapped, LogLine/formatLogTime,
  estimateMessageTokens, walkWorkspaceFiles, ai UI-message helpers) instead of
  hand-rolled copies; the studio adopt fetch now aborts on timeout.

## 0.15.2

No changes in this release.

## 0.15.1

No changes in this release.

## 0.15.0

### Minor Changes

- 851a4ab: Outbound calls connect on the managed platform: `stepPlaceCall` now dials Twilio
  with a webhook (`<agentUrl>/phone?…`) instead of inline TwiML, the platform's
  `/:slug/phone` and a self-hosted server's new HTTP `/phone` pass the call's
  parameters into the stream, and `agentUrl` defaults to the agent's own public
  URL. `stubPlaceCall` records `webhookUrl` (was `streamUrl`) and takes
  `publicUrl`. `outbound-call-agent` no longer needs `CALLER_AGENT_URL`.

## 0.14.4

### Patch Changes

- d266c27: Route `agent({ routes })` on the managed platform: `/:slug/api/*` now forwards
  to the agent's sandbox (per-IP rate limited), so a deployed page's
  `fetch("api/…")` no longer 404s.

## 0.14.3

### Patch Changes

- d648b81: Agents can press phone keys: `sendDtmf(ctx, keys)` (on
  `@alexkroman1/aai/experimental`) plays DTMF tones into the session's audio,
  which a `WS /phone` call carries to the carrier in-band, so an agent can answer
  an automated phone menu ("press 1 for…") or enter an extension.
  `sentDtmfCalls(ctx)` reads back what a `createToolContext` tool pressed. The
  outbound-call-agent template gains a `press_keys` tool and prompt guidance for
  phone menus.

## 0.14.2

### Patch Changes

- d66b0c3: Rewrite hand-rolled state machines as XState statecharts: the AssemblyAI TTS
  cancel/reconnect lifecycle, the platform socket reconnect loop, the pipeline
  session lifecycle and push-to-talk turn, the browser session connection
  lifecycle, the workflow form submission, and the `aai dev` restart supervisor.
  Share one backoff reconnect loop (`createBackoffLoop` in `/internal`) between
  the inbox and studio event stream.

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
