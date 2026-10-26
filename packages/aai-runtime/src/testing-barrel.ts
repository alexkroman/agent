// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/testing` — the PURE testing door of an agent
 * project: every fake, recorder and reader a spec needs that installs nothing,
 * and the drivers that run an agent's own machinery for real — a DURABLE
 * workflow run and a TEXT agent turn.
 *
 * A test file imports from two places: this subpath, and
 * `@alexkroman1/aai-runtime/testing/vitest` for everything that INSTALLS or
 * RESTORES (and for the eval suites). This one carries every public name of
 * `@alexkroman1/aai/testing` — `createToolContext`, `runTool`, `expectToolOk`,
 * `stubGenerate`, `createWorkflowContext`, … — re-exported as the SAME
 * declarations, so a type from either package is one type.
 *
 * ```ts
 * import { workflow } from "@alexkroman1/aai";
 * import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
 *
 * const approve = workflow({
 *   description: "Hold a draft until a reviewer answers.",
 *   run: async (_input, ctx) => await ctx.waitFor<{ approved: boolean }>("approval:1"),
 * });
 *
 * const run = await runWorkflow(approve, { draft: "…" });
 * console.log(run.status); // "running" — parked on the reviewer
 *
 * await run.signal("approval:1", { approved: true });
 * console.log(run.status); // "completed"
 * ```
 *
 * ## The CONTEXT and the ENGINE
 *
 * `createWorkflowContext` (declared in the SDK) hands a workflow body a `ctx`
 * that RECORDS — the right tool for asserting what a body asked for, and
 * explicitly not a durability test. `runWorkflow` runs the real engine over the
 * memory journal, so a spec can assert that a run slept, resumed, retried, was
 * answered, and survived a dead worker.
 *
 * `scriptedTextModel` and `runTextAgent` are the same idea one mode over: the
 * script is a step — what the model says, what it calls — and the text agent
 * underneath is the real one.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { runTextAgent } from "@alexkroman1/aai-runtime/testing";
 *
 * const run = await runTextAgent(
 *   agent({ name: "Desk", mode: "text" }),
 *   "where is order 7?",
 *   { script: [{ text: "It shipped yesterday." }] },
 * );
 * console.log(run.text); // "It shipped yesterday."
 * ```
 *
 * ## Why the SDK's helpers are re-exported HERE
 *
 * `@alexkroman1/aai` never imports this package (the dependency runs one way),
 * and the engine is runtime — so the one door has to be on the runtime, and
 * the SDK's helpers are re-exported in this direction. They stay DECLARED (and
 * versioned, as `aai:testing`) in the SDK; here they are owned by this
 * package's `eval-stubs` and `testing-stubs` capabilities, because dropping
 * one from this door would be this package's break.
 *
 * ## Runner-agnostic, deliberately
 *
 * Nothing here installs a global or owns a lifetime a runner has to unwind —
 * the workflow driver injects its own dispatcher, so no timer is ever armed —
 * which is this repo's rule for what may stay off a `/vitest` subpath
 * (konsistent `published-testing-split`). It does not import vitest.
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate: a new symbol in one of these modules does not ship as public API
 * until it is added here.
 *
 * @module testing
 */

// Every public name of `@alexkroman1/aai/testing`, as the same declarations.
// `testing-doors.test.ts` holds this list to that barrel's, so a helper the SDK
// gains and this door lacks fails there rather than in an author's import.
export {
  createRecordingWorkflows,
  createRouteContext,
  createRunSnapshot,
  createSlotStore,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  type DeployedConfig,
  type DeployedStage,
  deployedAgent,
  dialogRefusalPattern,
  dialogResultSchema,
  endSessionCalls,
  eventsOf,
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
  isEvent,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSignal,
  type RecordedSleep,
  type RecordedStart,
  type RecordedStep,
  type RecordingWorkflows,
  type RecordingWorkflowsOptions,
  type RouteContextOverrides,
  type RunSnapshotOverrides,
  routeHandlerOf,
  routeOf,
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
  type StubGatewayRoute,
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
  sessionEvent,
  stubClientInbox,
  stubClientTranscript,
  stubDelegate,
  stubFetchRoutes,
  stubGateway,
  stubGatewayRoute,
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
} from "@alexkroman1/aai/testing";
// What `TextAgentOptions` extends and the `Db` its `db` takes (owned by
// `runtime` and `db`), so a spec building turn options can name them.
export type { HostAgentOptions } from "./host-agent-options.ts";
export type { Db } from "./postgres-db.ts";
export {
  type RunTextAgentOptions,
  runTextAgent,
  type TextAgentTestRun,
  type TextAgentTestToolCall,
} from "./testing/run-text-agent.ts";
export { DEFAULT_MAX_DELIVERIES, runWorkflow } from "./testing/run-workflow.ts";
export type {
  RunWorkflowOptions,
  WorkflowTestHandle,
  WorkflowTestRead,
  WorkflowTestRun,
  WorkflowTestSignalOptions,
  WorkflowTestStep,
  WorkflowTestWait,
} from "./testing/run-workflow-types.ts";
export {
  type ScriptedTextStep,
  type ScriptedToolCall,
  scriptedTextModel,
} from "./testing/scripted-text-model.ts";
// `RunTextAgentOptions` extends the per-turn options with them, and this
// subpath published neither the extension nor the thing extended. Same
// declaration `@alexkroman1/aai-runtime` exports, re-exported so a spec that
// builds turn options up in a helper can name what it is building.
export type { TextAgentOptions, TextTurnOptions } from "./text-agent/index.ts";
// The opaque journal `RunWorkflowOptions.journal` takes and the factory for one
// (to start two runs in one world) — owned by `workflow` on the root barrel,
// re-exported so a spec can name what its options take without the root.
export {
  createMemoryJournal,
  type WorkflowJournal,
  type workflowJournalBrand,
} from "./workflow/journal/handle.ts";
// The journal STORE and its records are not here: `runWorkflow` takes the
// opaque `WorkflowJournal` (the `workflow` capability, on the root barrel), and
// what a spec reads off a run is the handle's own `steps`, `reads` and `waits`.
