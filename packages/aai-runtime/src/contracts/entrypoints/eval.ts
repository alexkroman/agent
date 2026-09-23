// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `eval`.
 *
 * Driving an agent from TEXT to measure what it did — the session with its two
 * speech stages faked, the readers over its event stream, the credential gate,
 * the scripted model a keyless run falls back to, and the vitest suite that
 * chooses between them.
 *
 * ONE capability over two subpaths (`/eval` and `/eval/vitest`) rather than two,
 * for the reason `aai`'s `testing` capability spans `/testing` and
 * `/testing/vitest`: the split between them is which files pull the test RUNNER,
 * not which promise is being made. A case moving from a hand-rolled `test()` to
 * `describeEval` crosses that line without the promise changing.
 *
 * A simulated caller and a judge are `eval-simulate`'s (`/eval/simulate`), and
 * the two newest per-turn claims (`expectCalled`, `lastToolResultIn`) are
 * `eval-assert`'s — each moves apart from the harness.
 *
 * Re-exported from `@alexkroman1/aai-runtime/eval` and
 * `@alexkroman1/aai-runtime/eval/vitest`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

// `StepFetch` only. Both types are re-exported by the eval barrel so a case
// imports from one subpath, but `RunCodeExecutor` is already the `runtime`
// capability's — it is on the root barrel, and a name belongs to exactly one
// contract or a change to it bumps two epochs. Claiming it here would also read
// as MOVING it, which on the runtime's export list is a removal.
// `EvalWorkflowEngineOptions` is what `EvalWorkflowsOptions` indexes for `speech`
// and `stepFetch`. `HostGenerateFn` was `EvalSessionOptions.generate`, a field
// that is host-only now; the name stays because a retained epoch's frozen case
// imports it. (`HostAgentOptions`, which both option bags extend, is the
// `runtime` capability's — see `RunCodeExecutor` above for why a name is owned
// once.)
export type {
  EvalWorkflowEngineOptions,
  HostGenerateFn,
  StepFetch,
  // The parameter of `HostGenerateFn`'s `onUsage`, so it travels with it: an
  // eval supplying a `generate` double writes this type or cannot type the
  // callback at all.
  StepUsage,
} from "../../eval-barrel.ts";
export {
  completedOutput,
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  customEventsIn,
  DEFAULT_RUN_TIMEOUT_MS,
  describeToolCalls,
  describeTurn,
  type EvalCredentials,
  type EvalEmitted,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSleep,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  errorsIn,
  evalCredentials,
  evalTextCredentials,
  evalWorkflowCredentials,
  expectToolBeforeSpeech,
  installStubLlm,
  installStubSpeechProviders,
  lastStateIn,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  runCodeIn,
  runCodeOutput,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  type StubLlm,
  type StubScript,
  type StubSpeechProviders,
  type StubStep,
  type StubSttSession,
  type StubTtsSession,
  saidIn,
  statesIn,
  TURN_ENDS,
  toolArgsIn,
  toolCallsInEvents,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
  toolResultsIn,
  turnCalling,
  type VmRunCodeOptions,
} from "../../eval-barrel.ts";
export {
  type DescribeEvalOptions,
  type DescribeTextEvalOptions,
  describeEval,
  describeTextEval,
  describeWorkflowEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
  type EvalTextTest,
  type EvalTextTestContext,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
  resolveEvalMode,
  resolveWorkflowEvalMode,
} from "../../eval-vitest-barrel.ts";
