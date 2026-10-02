// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/testing/vitest` — the vitest-coupled testing door:
 * everything that INSTALLS or RESTORES, and the eval suites.
 *
 * A test file imports from two places: `@alexkroman1/aai-runtime/testing` for
 * every fake and reader that installs nothing, and this subpath for the rest.
 * One import serves a unit spec and an eval file alike:
 *
 * - every installer of `@alexkroman1/aai/testing/vitest` (`installStubGateway`,
 *   `installStubStepFetch`, `installStubTranscribe`, …), each of which arms a fake
 *   and restores it with `onTestFinished`;
 * - everything `@alexkroman1/aai-runtime/eval/vitest` provides — the
 *   `describeEval` / `describeTextEval` / `describeWorkflowEval` suites, the
 *   session and the readers, the simulated caller and the judge, and the SDK
 *   stubs a case composes with.
 *
 * ```ts
 * import type { AgentDef } from "@alexkroman1/aai";
 * import { describeEval, expectCalled } from "@alexkroman1/aai-runtime/testing/vitest";
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
 * Every name is a re-export of the SAME declaration as its original subpath,
 * so ownership does not move: the eval names keep their `eval*` capabilities,
 * the SDK stubs `eval-stubs`, and the other installers `testing-stubs`.
 * `vitest` is an OPTIONAL peer dependency, and importing this subpath is what
 * pulls it; `/testing` and `/eval` stay importable without it.
 *
 * @module testing/vitest
 */

// The SDK's installers, each a fake plus `onTestFinished(restore)` — on the
// SDK's own runner-flavoured subpath for the same reason this one is
// (`published-testing-split`).
export {
  installStubClientInbox,
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  installStubWorkflows,
  type StubWorkflowsOptions,
} from "@alexkroman1/aai/testing/vitest";
// Everything the eval door carries, so an eval file needs no second import.
// `testing-doors.test.ts` holds this list to `/eval/vitest`'s.
export {
  type CallVerdict,
  type CriterionVerdict,
  completedOutput,
  createRecordingWorkflows,
  createStubSttOpener,
  createStubTtsOpener,
  createVmRunCode,
  customEventsIn,
  DEFAULT_MAX_TURNS,
  DEFAULT_RUN_TIMEOUT_MS,
  type DescribeEvalOptions,
  type DescribeTextEvalOptions,
  describeEval,
  describeTextEval,
  describeToolCalls,
  describeTurn,
  describeWorkflowEval,
  dialogRefusalPattern,
  dialogResultSchema,
  END_CALL_TOOL,
  type EvalCaseOptions,
  type EvalCredentials,
  type EvalEmitted,
  type EvalMode,
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
  type EvalTest,
  type EvalTestContext,
  type EvalTextAgent,
  type EvalTextAgentOptions,
  type EvalTextTest,
  type EvalTextTestContext,
  type EvalToolCall,
  type EvalTurn,
  type EvalWorkflowCaseOptions,
  type EvalWorkflowEngineOptions,
  type EvalWorkflowRun,
  type EvalWorkflows,
  type EvalWorkflowsOptions,
  type EvalWorkflowTest,
  type EvalWorkflowTestContext,
  errorsIn,
  evalCredentials,
  evalNetwork,
  evalSimulation,
  evalTextCredentials,
  evalWorkflowCredentials,
  eventsOf,
  expectCalled,
  expectToolBeforeSpeech,
  type HostAgentOptions,
  type HostGenerateFn,
  installStubLlm,
  installStubSpeechProviders,
  isEvent,
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
  type RecordingWorkflows,
  type RecordingWorkflowsOptions,
  type RunCodeExecutor,
  resolveEvalMode,
  resolveWorkflowEvalMode,
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
  type StubGatewayRoute,
  type StubLlm,
  type StubScript,
  type StubSpeech,
  type StubSpeechOptions,
  type StubSpeechProviders,
  type StubStep,
  type StubStepDelegate,
  type StubStepFetch,
  type StubSttSession,
  type StubTranscribe,
  type StubTranscribeOptions,
  type StubTtsSession,
  type StubUploads,
  type StubUploadsOptions,
  saidIn,
  simulateCall,
  statesIn,
  stubGatewayRoute,
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
} from "./eval-vitest-barrel.ts";
