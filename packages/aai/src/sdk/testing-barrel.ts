// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/testing` — framework-agnostic test helpers for agent code.
 *
 * A FACADE. The subpath resolves here rather than at `testing.ts`, which buys two
 * things the direct form could not. That module can be SPLIT as it grows without
 * moving the published entry point — the path an implementation file happens to
 * have is not a thing to promise anyone — and a name it gains next reaches the
 * public surface only when a line is added below, rather than the moment it is
 * written.
 *
 * Named re-exports rather than `export *` for the second half of that: the
 * wildcard form re-exports whatever arrives, and needs a `noReExportAll`
 * suppression the escape-hatch ratchet only lets move down.
 *
 * @module testing
 */

export {
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  deployedAgent,
  expectDialogOk,
  expectToolOk,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSleep,
  type RecordedStep,
  type RunSnapshotOverrides,
  routeStepFetch,
  runTool,
  type SentEvent,
  STUB_SPEECH_PCM_BYTES,
  type StepRoute,
  type StepUnmatched,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  type StubEmitted,
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGatewayRoute,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  type StubReporter,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  type StubStepAnswer,
  type StubStepFetch,
  type StubStepRequest,
  type StubTranscribe,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubTranscribeOptions,
  type StubUpload,
  type StubUploads,
  type StubUploadsOptions,
  type StubUploadWrite,
  schemaInputIssues,
  stubDelegate,
  stubGateway,
  stubGatewayRoute,
  stubGenerate,
  stubReporter,
  stubSpeech,
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
} from "./testing.ts";
