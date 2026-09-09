// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 2.
 *
 * Epoch 3 reached a new name — `SystemPromptOption`, the union
 * `AgentDef.systemPrompt` became when a prompt was allowed to be a thunk. This
 * capability declares no such field itself; it is reached through
 * `deployedAgent`, whose whole job is to hand a spec the def a DEPLOYED agent
 * runs. So the promise this file tests is that a spec written at epoch 2 still
 * compiles against a def whose prompt type widened.
 *
 * **What a retained epoch does and does not promise here.** A spec that ASSERTS
 * on the prompt — reads it, matches it, passes it to an expectation — compiles
 * unchanged, and the wire-side value is a string as it always was
 * (`expectDeployable` answers an `AgentConfig`, which is the serializable shape
 * and cannot hold a function). A spec that ANNOTATED the def's own field
 * `string` does not, because a union is not assignable to one of its arms. That
 * is the edge of the promise, and it is written here rather than left for
 * somebody to discover, because the same widening broke exactly one read site
 * in this repo and it was an annotation of that shape.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **It names every one of epoch 2's 92 exports.** The gate requires it
 * (`api-contracts-gate.test.ts`) and the reason is worth understanding: a
 * fixture that names one signature freezes one signature, while every other
 * name in the epoch compiles because nothing mentions it. So the back half of
 * this file is a roll-call, and the front half is the part written to be read.
 *
 * **Its specifiers are RELATIVE.** The same gate insists, and rightly:
 * importing the package by name would resolve through its own `exports` map to
 * whatever the current build publishes, so the fixture would prove the CURRENT
 * surface compiles rather than that epoch 2's does.
 *
 * @module
 */

import { agent } from "../../../index.ts";
import {
  commandedBuiltins,
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  deployedAgent,
  dialogRefusalPattern,
  dialogResultSchema,
  expectDeployable,
  expectDialogOk,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectToolOk,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSleep,
  type RecordedStep,
  type RunSnapshotOverrides,
  routeStepFetch,
  runGuardrail,
  runTool,
  type ScriptedToolContext,
  type ScriptedToolContextOptions,
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
  type StubGenerateRoutes,
  type StubGenerateScript,
  type StubReporter,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  type StubStepAnswer,
  type StubStepDelegate,
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
  scriptedToolContext,
  stubDelegate,
  stubGateway,
  stubGatewayRoute,
  stubGenerate,
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
} from "../../../sdk/testing-barrel.ts";
import {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  installStubWorkflows,
  type StubWorkflowsOptions,
} from "../../../sdk/testing-vitest-barrel.ts";

// A project whose tools are FILES: `deployedAgent` lowers the discovered
// modules and `system-prompt.md` onto the def a deployed agent runs, which is
// the only way a spec sees the whole agent.
export const deployed = deployedAgent(agent({ name: "Desk" }), {
  systemPrompt: "Be brief.",
});

// The wire side, which is where the prompt is still a string — `AgentConfig` is
// the serializable shape, so the annotation below is the one that keeps holding.
export const promptOnTheWire: string = expectDeployable(deployed).systemPrompt;

// A tool spec's context, with inert defaults and a recording `send`.
export const ctx = createToolContext({ sessionId: "spec" });

// ── The rest of epoch 2's promised surface.
//
//    The example above pins the SHAPES the transition touched; these are the
//    names it promised and did not reach. Named here because a retained epoch
//    is a promise about all of it, and a fixture that names one signature
//    freezes one signature (`api-contracts-gate.test.ts`).

export type Epoch2Types = {
  projectFiles: ProjectFiles;
  recordedSleep: RecordedSleep;
  recordedStep: RecordedStep;
  runSnapshotOverrides: RunSnapshotOverrides;
  scriptedToolContext: ScriptedToolContext;
  scriptedToolContextOptions: ScriptedToolContextOptions;
  sentEvent: SentEvent;
  stepRoute: StepRoute;
  stepUnmatched: StepUnmatched;
  stubDelegate: StubDelegate;
  stubDelegateCall: StubDelegateCall;
  stubDelegateReply: StubDelegateReply;
  stubDelegateRoute: StubDelegateRoute;
  stubEmitted: StubEmitted;
  stubGateway: StubGateway;
  stubGatewayCall: StubGatewayCall;
  stubGatewayOptions: StubGatewayOptions;
  stubGatewayRoute: StubGatewayRoute;
  stubGenerate: StubGenerate;
  stubGenerateCall: StubGenerateCall;
  stubGenerateReply: StubGenerateReply;
  stubGenerateRoute: StubGenerateRoute;
  stubGenerateRoutes: StubGenerateRoutes;
  stubGenerateScript: StubGenerateScript;
  stubReporter: StubReporter;
  stubSpeech: StubSpeech;
  stubSpeechCall: StubSpeechCall;
  stubSpeechOptions: StubSpeechOptions;
  stubStepAnswer: StubStepAnswer;
  stubStepDelegate: StubStepDelegate;
  stubStepFetch: StubStepFetch;
  stubStepRequest: StubStepRequest;
  stubTranscribe: StubTranscribe;
  stubTranscribeCall: StubTranscribeCall;
  stubTranscribeFailure: StubTranscribeFailure;
  stubTranscribeLeg: StubTranscribeLeg;
  stubTranscribeOptions: StubTranscribeOptions;
  stubUpload: StubUpload;
  stubUploadWrite: StubUploadWrite;
  stubUploads: StubUploads;
  stubUploadsOptions: StubUploadsOptions;
  stubWorkflowsOptions: StubWorkflowsOptions;
  testToolContext: TestToolContext;
  toolBearingAgent: ToolBearingAgent;
  toolContextOverrides: ToolContextOverrides;
  toolRunner: ToolRunner;
  workflowContextOptions: WorkflowContextOptions;
  workflowContextRecorder: WorkflowContextRecorder;
};

export const epoch2Values = [
  STUB_SPEECH_PCM_BYTES,
  WORKFLOW_CONTEXT_NOW,
  commandedBuiltins,
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  deployedAgent,
  dialogRefusalPattern,
  dialogResultSchema,
  expectDeployable,
  expectDialogOk,
  expectDialogRefused,
  expectPromptBuiltinsDeclared,
  expectToolOk,
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepDelegate,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  installStubWorkflows,
  parseSchemaInput,
  parseToolInput,
  routeStepFetch,
  runGuardrail,
  runTool,
  schemaInputIssues,
  scriptedToolContext,
  stubDelegate,
  stubGateway,
  stubGatewayRoute,
  stubGenerate,
  stubReporter,
  stubSpeech,
  stubStepDelegate,
  stubStepFetch,
  stubStepInfo,
  stubTranscribe,
  stubUploads,
  toolInputIssues,
  toolOf,
  toolRunner,
] as const;
