// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `testing-stubs`.
 *
 * The SDK's unit-level test helpers — `createToolContext`, `runTool`,
 * `expectToolOk`, `stubGenerate`, `stubDelegate`, `createWorkflowContext`,
 * `deployedAgent`, the fetch-route table, … — and the installers that arm them,
 * as this package's two testing doors re-export them: `/testing` carries every
 * name of `@alexkroman1/aai/testing`, and `/testing/vitest` every installer of
 * `@alexkroman1/aai/testing/vitest`.
 *
 * DECLARED in `@alexkroman1/aai`, where `aai:testing` versions them. This
 * contract is the promise that the runtime's doors keep carrying them: a name
 * dropped from a re-export list breaks a spec that never imported the SDK's
 * testing subpaths, and that is this package's change to classify.
 *
 * The stubs an EVAL composes with are not here: `eval-stubs` already owns
 * them (a name belongs to exactly one capability), and they ride the same two
 * doors. Its own capability rather than part of `eval-stubs` or `testing` for
 * the reason `eval-stubs` is: an SDK helper growing an option is not a change
 * to the eval harness, nor to the workflow and text drivers.
 *
 * Re-exported from `@alexkroman1/aai-runtime/testing` and
 * `@alexkroman1/aai-runtime/testing/vitest`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  commandedBuiltins,
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  type DeployedConfig,
  type DeployedStage,
  deployedAgent,
  endSessionCalls,
  expectDeployable,
  expectDialogOk,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectToolOk,
  type FetchRouteHandler,
  type FetchRouteHit,
  type FetchRouteRequest,
  type FetchRoutesOptions,
  type FetchRouteTable,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSleep,
  type RecordedStart,
  type RecordedStep,
  type RunSnapshotOverrides,
  runGuardrail,
  runTool,
  type SaidLine,
  type SentEvent,
  STUB_SPEECH_PCM_BYTES,
  type StubClientInbox,
  type StubClientInboxCall,
  type StubClientInboxOptions,
  type StubClientTranscript,
  type StubClientTranscriptAnswer,
  type StubClientTranscriptCall,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  type StubDelegateScript,
  type StubEmitted,
  type StubFetchRoutes,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  type StubGenerateScript,
  type StubPlaceCall,
  type StubPlaceCallOptions,
  type StubPlaceCallRefusal,
  type StubPlacedCall,
  type StubReporter,
  type StubSpeechCall,
  type StubStepAnswer,
  type StubStepRequest,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubUpload,
  type StubUploadWrite,
  schemaInputIssues,
  stubClientInbox,
  stubClientTranscript,
  stubDelegate,
  stubFetchRoutes,
  stubGateway,
  stubGenerate,
  stubPlaceCall,
  stubReporter,
  stubSpeech,
  stubStepDelegate,
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
  type TestToolContext,
  type ToolBearingAgent,
  type ToolContextOverrides,
  type ToolRunner,
  toolInputIssues,
  toolOf,
  toolRunner,
  WORKFLOW_CONTEXT_NOW,
  type WorkflowContextOptions,
  type WorkflowContextRecorder,
} from "../../testing-barrel.ts";
export {
  installFetchRoutes,
  installStubClientInbox,
  installStubGateway,
  installStubReporter,
  installStubWorkflows,
  type StubWorkflowsOptions,
} from "../../testing-vitest-barrel.ts";
