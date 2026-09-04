// Copyright 2026 the AAI authors. MIT license.
/**
 * Test helpers for agent code (the `@alexkroman1/aai/testing` subpath).
 *
 * **Framework-agnostic on purpose.** Everything here returns a fake rather than
 * installing one — `createToolContext`'s `send` records into an array instead of
 * calling a mock library, and each `stub*` hands back a `restore` the caller
 * owns. So this module carries no test-runner dependency, a project on another
 * runner can still use all of it, and a spy can be passed IN wherever a spec
 * wants call-order assertions. The half that installs into vitest, including an
 * `install*` per fake that registers its own cleanup, is
 * `@alexkroman1/aai/testing/vitest`.
 *
 * **This module is the assembly point, not the implementation.** Each fake is a
 * function plus the shape of what it records, and lives in its own module beside
 * this one; what is here is the re-export surface and `stubReporter`. Reading
 * order, roughly by what a spec reaches for first:
 *
 * - `_testing-context.ts` — `createToolContext`, and the stub `db`/`workflows`
 *   its defaults are built from.
 * - `testing-tools.ts` — `toolOf` / `runTool` / `toolRunner`, the tool under the
 *   name the model calls it by, the last of those being `runTool` with the agent
 *   bound; `testing-discovery.ts` — `deployedAgent`, which lowers a project's
 *   own FILES (`tools/`, `system-prompt.md`) onto its `agent.ts` default export
 *   the way the build does — the one function a spec needs.
 * - `_testing-tool-results.ts` — `expectToolOk` / `expectDialogOk`, unwrapping what a gated
 *   tool answered; `_testing-schema.ts` — what a tool's or workflow's input
 *   schema accepts, without reaching through `~standard`.
 * - `testing-delegate.ts` — `stubDelegate`, the same seam one loop up: what a
 *   SUBAGENT concluded, without running one.
 * - `_testing-step-fetch.ts`, `testing-gateway.ts`, `testing-generate.ts`,
 *   `testing-speech.ts`, `_testing-transcribe.ts`, `testing-uploads.ts` — the
 *   slots a step reaches through, each answered in memory.
 * - `testing-workflows.ts` — run snapshots and progress streams, for a page;
 *   `testing-workflow-ctx.ts` — `createWorkflowContext`, the `ctx` a workflow BODY
 *   takes, which nothing else can hand it.
 *
 * @module testing
 */

import { publishStepInfoReader } from "./step-attempt.ts";
import { publishStepReporter } from "./step-report.ts";
import { DEFAULT_STEP_MAX_ATTEMPTS } from "./workflow-ctx-options.ts";

export {
  createStubWorkflows,
  createToolContext,
  type SentEvent,
  type TestToolContext,
  type ToolContextOverrides,
} from "./_testing-context.ts";
export {
  parseSchemaInput,
  parseToolInput,
  schemaInputIssues,
  toolInputIssues,
} from "./_testing-schema.ts";
export {
  routeStepFetch,
  type StepRoute,
  type StepUnmatched,
  type StubStepAnswer,
  type StubStepFetch,
  type StubStepRequest,
  stubStepFetch,
} from "./_testing-step-fetch.ts";
export { expectDialogOk, expectToolOk } from "./_testing-tool-results.ts";
export {
  type StubTranscribe,
  type StubTranscribeCall,
  type StubTranscribeFailure,
  type StubTranscribeLeg,
  type StubTranscribeOptions,
  stubTranscribe,
} from "./_testing-transcribe.ts";
export {
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  stubDelegate,
} from "./testing-delegate.ts";
export {
  deployedAgent,
  type ProjectFiles,
} from "./testing-discovery.ts";
export {
  type StubGateway,
  type StubGatewayCall,
  type StubGatewayOptions,
  type StubGatewayRoute,
  stubGateway,
  stubGatewayRoute,
} from "./testing-gateway.ts";
export {
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  stubGenerate,
} from "./testing-generate.ts";
export {
  STUB_SPEECH_PCM_BYTES,
  type StubSpeech,
  type StubSpeechCall,
  type StubSpeechOptions,
  stubSpeech,
} from "./testing-speech.ts";
export {
  runTool,
  type ToolBearingAgent,
  type ToolRunner,
  toolOf,
  toolRunner,
} from "./testing-tools.ts";
export {
  type StubUpload,
  type StubUploads,
  type StubUploadsOptions,
  type StubUploadWrite,
  stubUploads,
} from "./testing-uploads.ts";
// Driving a workflow BODY, which nothing else can do: its steps are ordinary
// functions a spec calls directly and its declaration is a value a spec reads,
// but the body takes a `ctx` only an engine constructs. Three templates
// hand-rolled one.
export {
  createWorkflowContext,
  type RecordedSleep,
  type RecordedStep,
  WORKFLOW_CONTEXT_NOW,
  type WorkflowContextOptions,
  type WorkflowContextRecorder,
} from "./testing-workflow-ctx.ts";
export {
  createProgressStream,
  createRunSnapshot,
  type RunSnapshotOverrides,
} from "./testing-workflows.ts";

/** One chunk `stepEmit()` wrote, and the stream it went to. */
export type StubEmitted = {
  /** The stream named at the call site. */
  namespace: string;
  /** The value, exactly as the step passed it. */
  chunk: unknown;
};

/** What {@link stubReporter} returns. */
export type StubReporter = {
  /** Every line `stepReport()` wrote, oldest first. */
  lines: string[];
  /** Every chunk `stepEmit()` wrote, oldest first. */
  emitted: StubEmitted[];
  /** Unpublish. Call it in an `afterEach` — see {@link stubReporter}. */
  restore: () => void;
};

/**
 * Answer `stepInfo()` for the step under test, so a body's RETRY branch is
 * reachable from a spec.
 *
 * A step that degrades on its last attempt has two paths and a spec could only
 * ever take one: outside a run `stepInfo()` answers `undefined`, which a body
 * reads as "not retrying". So the branch that exists precisely for the case that
 * goes wrong was the branch no test could enter — and it is the one whose
 * failure is quiet, since a body that mis-reads the ceiling degrades early on
 * every run and still returns an answer.
 *
 * ```ts
 * import { stubStepInfo } from "@alexkroman1/aai/testing";
 * import { onTestFinished, expect, test } from "vitest";
 *
 * declare function summarizeChapter(text: string): Promise<string>;
 *
 * test("falls back to the cheap model on the last attempt", async () => {
 *   const stub = stubStepInfo({ attempt: 3, maxAttempts: 3 });
 *   onTestFinished(stub.restore);
 *   expect(await summarizeChapter("…")).toContain("…");
 * });
 * ```
 *
 * `isLastAttempt` is DERIVED from the two numbers rather than accepted, for the
 * reason the real reader derives it: a fake that let a spec set `attempt: 1` and
 * `isLastAttempt: true` would let a body pass against a state no run can be in.
 *
 * Publishing REPLACES, so a spec that forgets to restore leaves this answering
 * the next file's steps — the same rule {@link stubReporter} follows, and the
 * same remedy.
 *
 * @public
 */
export function stubStepInfo(step: {
  /** 1-based. Defaults to 1. */
  attempt?: number | undefined;
  /** Defaults to whichever is larger of 3 (the SDK's own default) and `attempt`. */
  maxAttempts?: number | undefined;
  /** Defaults to `"step"`. */
  name?: string | undefined;
}): { restore: () => void } {
  const attempt = step.attempt ?? 1;
  const maxAttempts = step.maxAttempts ?? Math.max(DEFAULT_STEP_MAX_ATTEMPTS, attempt);
  const name = step.name ?? "step";
  publishStepInfoReader(() => ({
    name,
    key: `${name}#0`,
    attempt,
    maxAttempts,
    isLastAttempt: attempt >= maxAttempts,
  }));
  return { restore: () => publishStepInfoReader(undefined) };
}

/**
 * Capture what a step narrates and emits.
 *
 * `stepReport()` and `stepEmit()` both go through a published slot, and with nothing
 * published they fall back to the console — which is right for a step under test
 * that nobody is asserting on, and useless the moment the narration IS the
 * subject. It is for a step whose partial results are part of its contract: a
 * fan-out that emits each segment as it lands has a page depending on the shape
 * of those chunks, and nothing else in a spec can see them.
 *
 * The two are separated the way the streams are, so a spec asserting a chunk
 * never has to filter the sentences out of it.
 *
 * ```ts no-check
 * const reported = stubReporter();
 * afterEach(reported.restore);
 *
 * await transcribeSegment(uploadId, format, segment);
 * expect(reported.emitted).toEqual([
 *   { namespace: "transcript", chunk: { index: 0, text: "hello there" } },
 * ]);
 * ```
 *
 * Publishing REPLACES, so a spec that forgets to restore leaves this one
 * answering the next file's steps — the same rule {@link stubStepFetch} follows,
 * and the same remedy.
 *
 * @public
 */
export function stubReporter(): StubReporter {
  const lines: string[] = [];
  const emitted: StubEmitted[] = [];
  publishStepReporter((chunk, options) => {
    // The namespace is what tells the two apart, and it is the SAME test
    // `stepEmit()`'s own contract rests on: an absent one is the default stream,
    // which is `stepReport()`'s.
    if (options?.namespace === undefined) lines.push(String(chunk));
    else emitted.push({ namespace: options.namespace, chunk });
  });
  return { lines, emitted, restore: () => publishStepReporter(undefined) };
}
