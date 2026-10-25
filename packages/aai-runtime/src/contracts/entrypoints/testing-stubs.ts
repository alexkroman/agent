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
 * DECLARED in `@alexkroman1/aai`, where `aai:testing` versions them. This is a
 * MIRROR of that capability (`{ "mirrors": "aai:testing" }` in
 * `contracts.json`): no epoch of its own, so an SDK change is classified once,
 * upstream. What it promises on its own — that the runtime's doors keep
 * carrying every name — is checked instead: dropping a name the SDK still
 * exports is refused (`scripts/_api-contracts-mirror.mjs`).
 *
 * The stubs an EVAL composes with are not here: `eval-stubs` already owns
 * them (a name belongs to exactly one capability), and they ride the same two
 * doors. Its own capability rather than part of `eval-stubs` or `testing` for
 * the reason `eval-stubs` is: an SDK helper growing an option is not a change
 * to the eval harness, nor to the workflow and text drivers.
 *
 * Re-exported from `@alexkroman1/aai-runtime/testing` and
 * `@alexkroman1/aai-runtime/testing/vitest`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract its
 * report and hold it to being a pure re-export of `aai:testing`. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createRunSnapshot,
  createSlotStore,
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
  expectSlotContract,
  expectToolOk,
  type FetchRouteHandler,
  type FetchRouteHit,
  type FetchRouteRequest,
  type FetchRoutesOptions,
  type FetchRouteTable,
  type FiredEvent,
  fireEvent,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSleep,
  type RecordedStart,
  type RecordedStep,
  type RouteContextOverrides,
  type RunSnapshotOverrides,
  runGuardrail,
  runTool,
  type SaidLine,
  type SentEvent,
  type SessionEventFields,
  type SessionEventRest,
  type SlotContractOptions,
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
  sessionEvent,
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
  toolNameOf,
  toolOf,
  toolRunner,
  WORKFLOW_CONTEXT_NOW,
  type WorkflowContextOptions,
  type WorkflowContextRecorder,
} from "../../testing-barrel.ts";
export {
  describeAgent,
  type InstallStubGatewayOptions,
  installStubClientInbox,
  installStubGateway,
  installStubReporter,
  installStubWorkflows,
  installStubWorld,
  type StubWorkflowsOptions,
  type StubWorld,
  type StubWorldOptions,
} from "../../testing-vitest-barrel.ts";
