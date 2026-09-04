// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `testing`.
 *
 * Testing a tool's `execute` in a user's own project: a `ToolContext` with
 * inert defaults and a recording `send`, the fakes its collaborators are driven
 * by (a model, a workflow client, a gateway), the three slots a step
 * body reaches through — the upload store, the HTTP `stepFetch` makes its
 * request with, and the synthesizer `stepSpeak` speaks through — and
 * `deployedAgent`, which is how a spec gets the def a DEPLOYED
 * agent runs when the project's tools are files rather than inline.
 *
 * Three families joined it, each because the same lines were being re-derived
 * in every project's specs rather than because the SDK grew a feature:
 *
 * - **The UNWRAPS.** `runTool` and `toolOf(...).execute(...)` answer `unknown` —
 *   the registry lookup is by string and discovery is a build step, so there is
 *   no tool map at the type level to recover the author's `R` from. `ok` and
 *   `okPosition` are that recovery, and they THROW on a refusal quoting it,
 *   which is the half a cast cannot do: `(result as { result: Order }).result`
 *   reads `undefined` off a `ToolFailure` and fails several assertions later,
 *   with the sentence the dialog wrote about what has to happen first thrown
 *   away.
 * - **The schema pair, twice over.** A tool's `inputSchema` and a workflow's
 *   `input` are both Standard Schemas, and asking one what it accepts by hand
 *   means optional-chaining the schema, narrowing on `.issues` and casting
 *   `.value`. `parseToolInput` / `toolInputIssues` name the tool;
 *   `parseSchemaInput` / `schemaInputIssues` take the schema itself, which is
 *   what a workflow's `input` needs. Both are here rather than one, because the
 *   positive and negative cases want different answers — the parsed value, or
 *   the issues — and because `~standard` is a wire contract between the schema
 *   library and the SDK, not something a spec should be naming. Whether the
 *   vendor's `validate` is synchronous or async is exactly the detail a
 *   hand-rolled version gets wrong first.
 * - **`stubTranscribe`.** The fourth published slot, beside the upload store,
 *   `stepFetch` and the synthesizer. It answers AssemblyAI's four transcription
 *   endpoints in memory, and it can REFUSE by answering an HTTP status rather
 *   than by minting a `TranscribeError` — a fake that constructed the error
 *   would be asserting the retryable-vs-terminal classification the spec is
 *   trying to test.
 *
 * `installStubUploads`, `installStubStepFetch`, `installStubReporter`,
 * `installStubSpeech` and `installStubTranscribe` are the `/vitest` half of the
 * same five fakes: the fake plus `onTestFinished(restore)`, so the runner unwinds
 * it instead of a hand-kept `restores` array with an `afterEach` that splices it.
 *
 * Re-exported from `@alexkroman1/aai/testing` and its `/vitest` half — one
 * capability across two subpaths, because they are one promise to an author:
 * what is on the second is only the INSTALLATION of what is on the first, split
 * off so the test-runner dependency is opt-in.
 *
 * This file is not shipped and nothing imports it — it exists so
 * `pnpm check:api-contracts` can extract a report for this capability alone,
 * hash it, and hold it to a committed epoch. See `scripts/api-contracts.mjs`.
 */

export {
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowCtx,
  deployedAgent,
  ok,
  okPosition,
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
  WORKFLOW_CTX_NOW,
  type WorkflowCtxOptions,
  type WorkflowCtxRecorder,
} from "../../sdk/testing.ts";
export {
  installStubGateway,
  installStubReporter,
  installStubSpeech,
  installStubStepFetch,
  installStubTranscribe,
  installStubUploads,
  type MockWorkflowsOptions,
  mockWorkflows,
} from "../../sdk/testing-vitest.ts";
