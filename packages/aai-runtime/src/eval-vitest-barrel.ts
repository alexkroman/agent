// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/eval/vitest` — THE import for an eval file.
 *
 * One `*.eval.test.ts` used to reach four subpaths of two packages: the suite
 * from here, the readers and the session from `/eval`, the simulated caller from
 * `/eval/simulate`, and the stubs a case composes with from
 * `@alexkroman1/aai/testing` and `/testing/vitest`. Every one of those names is
 * re-exported here — the SAME declarations, so a type from one door is the type
 * from another — and an eval needs no other import from either package for its
 * harness:
 *
 * ```ts
 * import type { AgentDef } from "@alexkroman1/aai";
 * import { describeEval, expectCalled } from "@alexkroman1/aai-runtime/eval/vitest";
 *
 * declare const agentDef: AgentDef;
 *
 * describeEval(agentDef, (test) => {
 *   test(
 *     "looks the order up before answering",
 *     async ({ session }) => {
 *       expectCalled(await session.say("where is order W1234?"), "look_up");
 *     },
 *     { stubReply: "Order W1234 shipped yesterday." },
 *   );
 * });
 * ```
 *
 * Why HERE rather than on `/eval`, and why not in the SDK:
 *
 * - **`/eval` must stay importable without vitest.** `vitest` is an OPTIONAL
 *   peer dependency and this module imports it (`describeEval` registers a
 *   suite, opens a session per case and closes it afterwards — everything
 *   defined here either INSTALLS something or OWNS a lifetime, the repo's rule
 *   for a runner-flavoured subpath). A harness that is not vitest — a load-test
 *   stub, a recording runner — imports `/eval`, the runner-free half this is
 *   built on. An eval FILE is always vitest (`*.eval.test.ts` is a vitest tier),
 *   so the one author-facing door is the vitest one.
 * - **The SDK cannot host it.** `@alexkroman1/aai` never imports this package
 *   (the dependency runs one way), and the harness is host runtime. So the
 *   re-export runs the other way: this subpath re-exports the SDK's unit-level
 *   stubs, which stay DECLARED on `@alexkroman1/aai/testing` for a tool's or a
 *   step's own spec.
 * - **Capabilities are unchanged.** A re-export does not move ownership: the
 *   readers stay `eval`'s, `evalNetwork` `eval-network`'s, the claims
 *   `eval-assert`'s, the simulation `eval-simulate`'s, and the SDK stubs
 *   `aai:testing`'s, each on its own epoch.
 *
 * `/eval/simulate` was removed for this reason (its names are here and on
 * `/eval`); `/eval` stays — it is the runner-free door, not a second
 * author-facing one.
 *
 * @module eval/vitest
 */

// The SDK's stubs a case COMPOSES with — the model gateway's routes, the step
// fetch, the dialog envelope, the event readers — declared on
// `@alexkroman1/aai/testing` for unit specs and re-exported so an eval reaches
// them through its one door. Only the ones an eval has a use for: a tool's own
// spec keeps importing `/testing`, which stays the unit-level surface.
export {
  createRecordingWorkflows,
  dialogRefusalPattern,
  dialogResultSchema,
  eventsOf,
  isEvent,
  type RecordingWorkflows,
  type RecordingWorkflowsOptions,
  routeStepFetch,
  type StepRoute,
  type StepUnmatched,
  type StubGatewayRoute,
  type StubSpeech,
  type StubSpeechOptions,
  type StubStepDelegate,
  type StubStepFetch,
  type StubTranscribe,
  type StubTranscribeOptions,
  type StubUploads,
  type StubUploadsOptions,
  stubGatewayRoute,
} from "@alexkroman1/aai/testing";
// …and their installers, which return a `restore` and so live on the SDK's
// runner-flavoured subpath (`published-testing-split`), as this one is.
export {
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
} from "@alexkroman1/aai/testing/vitest";
export {
  type DescribeEvalOptions,
  describeEval,
  type EvalCaseOptions,
  type EvalMode,
  type EvalTest,
  type EvalTestContext,
} from "./eval/describe.ts";
// The TEXT-agent suite. Its own function rather than a flag on `describeEval`
// for the reason there are two harnesses at all: `createRuntime` refuses
// `text: true` by name, so there is no session to open — see the module doc.
export {
  type DescribeTextEvalOptions,
  describeTextEval,
  type EvalTextTest,
  type EvalTextTestContext,
} from "./eval/describe-text.ts";
// The workflow-app suite. Its own function rather than a flag on `describeEval`
// because the two gate on different credentials and hand a case different
// things — see the module doc.
export {
  describeWorkflowEval,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
} from "./eval/describe-workflows.ts";
// WHICH MODEL a suite runs against — the decision every one of the three
// `describe*Eval` doors below makes before registering a case, published so a
// harness that is not vitest can ask the same question. See its module doc.
export { resolveEvalMode, resolveWorkflowEvalMode } from "./eval/eval-mode.ts";
// A simulated caller and a judge are not FIELDS of a case context: a case
// builds that pair with `evalSimulation` (re-exported below), which is its own
// `eval-simulate` capability.
// Everything on the runner-free half, so an eval file needs no second import
// from this package. Named rather than `export *`, for the reason `/eval`'s own
// doc gives: a name reaches a published surface only when a line says so.
// The simulated caller and the judge (`eval-simulate`), from the runner-free
// half like everything above; listed apart because they are their own capability.
export {
  type CallVerdict,
  type CriterionVerdict,
  completedOutput,
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  customEventsIn,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUN_TIMEOUT_MS,
  describeToolCalls,
  describeTurn,
  END_CALL_TOOL,
  type EvalCredentials,
  type EvalEmitted,
  type EvalNetwork,
  type EvalNetworkOptions,
  type EvalRequest,
  type EvalRequestFilter,
  type EvalRoute,
  type EvalRunOptions,
  type EvalSession,
  type EvalSessionOptions,
  type EvalSimulationContext,
  type EvalSimulationOptions,
  type EvalSleep,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowEngineOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  errorsIn,
  evalCredentials,
  evalNetwork,
  evalSimulation,
  evalTextCredentials,
  evalWorkflowCredentials,
  expectCalled,
  expectToolBeforeSpeech,
  type HostAgentOptions,
  type HostGenerateFn,
  installStubLlm,
  installStubSpeechProviders,
  type JudgeCallOptions,
  type JudgeInput,
  judgeCall,
  type LogContext,
  type LogFn,
  type Logger,
  type LogLevel,
  lastStateIn,
  lastToolResultIn,
  openEvalSession,
  openEvalTextAgent,
  openEvalWorkflows,
  type RunCodeExecutor,
  runCodeIn,
  runCodeOutput,
  type SimulateCallOptions,
  type SimulatedCall,
  type SimulatedCaller,
  type SimulatedTurn,
  type SimulationMetrics,
  type SimulationTarget,
  STUB_LLM_API_KEY_ENV,
  STUB_SPEECH_API_KEY_ENV,
  type StepFetch,
  type StepUsage,
  type SttError,
  type SttEvents,
  type SttOpener,
  type SttOpenOptions,
  type SttSession,
  type SttTurnMeta,
  type StubLlm,
  type StubScript,
  type StubSpeechProviders,
  type StubStep,
  type StubSttSession,
  type StubTtsSession,
  saidIn,
  simulateCall,
  statesIn,
  type TtsError,
  type TtsEvents,
  type TtsOpener,
  type TtsOpenOptions,
  type TtsSession,
  type TtsWordTiming,
  TURN_ENDS,
  toolArgsIn,
  toolCallsInEvents,
  toolCallsInTurns,
  toolNames,
  toolResultIn,
  toolResultsIn,
  transcriptOf,
  turnCalling,
  type Unsubscribe,
  type VmRunCodeOptions,
} from "./eval-barrel.ts";
