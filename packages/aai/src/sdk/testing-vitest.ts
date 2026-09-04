// Copyright 2026 the AAI authors. MIT license.
/**
 * The vitest-coupled half of the test helpers (`@alexkroman1/aai/testing/vitest`).
 *
 * `sdk/testing.ts` is framework-agnostic on purpose — it returns fakes rather
 * than installing them, so it carries no test-runner dependency and a project
 * using another runner can still build a `ToolContext`. That is the right
 * default and it is not free: `stubGateway` (`@alexkroman1/aai/testing`)
 * hands back a `fetch`
 * implementation, and the INSTALLATION of it was then written out by hand in
 * every workflow template, four times, each with the same paragraph explaining
 * why the SDK had not done it.
 *
 * So the coupling gets its own subpath instead of leaking into the main one.
 * `vitest` is an OPTIONAL peer dependency: importing this module is what pulls
 * it, importing `@alexkroman1/aai/testing` is not, and a project that never
 * writes a test resolves neither.
 *
 * **The rule for what belongs here: anything that installs, and anything that
 * restores.** Every fake on `@alexkroman1/aai/testing` that fills a published
 * slot hands back a `restore` the caller owns, and owning it means a registry —
 * `const restores: (() => void)[]` with an `afterEach` that splices it, written
 * out in template after template, three times in one file. The `install*` half
 * of this module is that fake plus `onTestFinished(restore)`: same object,
 * unwound by the runner in reverse order when the test that installed it ends.
 *
 * A fake with no lifetime (`stubGenerate`, `createToolContext`, the workflow
 * snapshots) gets no wrapper — there is nothing to restore, so a second name
 * for it would only be a second name.
 *
 * **`installStubWorkflows` is here for the other half of the same rule: `vi.fn` IS its
 * content.** It restores nothing and installs nothing, so it takes no `install`
 * prefix — but its methods have to be spies, because a spec of a
 * workflow-driving tool asserts on `start` and re-points `lastLine` per test.
 * A plain-function version would be a helper neither caller could use, so the
 * coupling is the feature rather than a leak.
 *
 * @module testing/vitest
 */

import { onTestFinished, vi } from "vitest";
import { createStubWorkflows } from "./_testing-context.ts";
import type { StubStepAnswer, StubStepFetch, StubStepRequest } from "./_testing-step-fetch.ts";
import { stubStepFetch } from "./_testing-step-fetch.ts";
import type { StubTranscribe, StubTranscribeOptions } from "./_testing-transcribe.ts";
import { stubTranscribe } from "./_testing-transcribe.ts";
import type { StubReporter } from "./testing.ts";
import { stubReporter } from "./testing.ts";
import type { StubGatewayCall, StubGatewayOptions } from "./testing-gateway.ts";
import { stubGateway } from "./testing-gateway.ts";
import type { StubSpeech, StubSpeechOptions } from "./testing-speech.ts";
import { stubSpeech } from "./testing-speech.ts";
import type { StubUpload, StubUploads, StubUploadsOptions } from "./testing-uploads.ts";
import { stubUploads } from "./testing-uploads.ts";
import type { WorkflowClient } from "./workflow-client.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * Install a fake LLM gateway as the global `fetch`, and return its call log.
 *
 * The calls array is what a spec asserts on, and it is live — a reference taken
 * before the code under test runs holds every call made after.
 *
 * **Lifetime is the caller's**, as it is for any `vi.stubGlobal`. This repo does
 * not set `unstubGlobals`, so a stub outlives its test unless the next one
 * replaces it; installing per test (which is the shape every caller wants
 * anyway) makes that moot, and `vi.unstubAllGlobals()` is the explicit undo.
 *
 * @param replies - Completion contents, in order; the last repeats — see
 *   `stubGateway` in `@alexkroman1/aai/testing`, which this installs.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the step under test is in another file, which is the point.
 * import { installStubGateway } from "@alexkroman1/aai/testing/vitest";
 * import { expect, test } from "vitest";
 * import { summarize } from "./workflows/digest.ts";
 *
 * test("summarize sends the article", async () => {
 *   const calls = installStubGateway('{"headline":"Otters use tools"}');
 *   await summarize("Otters use tools.");
 *   expect(calls[0]?.prompt).toContain("Otters use tools.");
 * });
 * ```
 *
 * @public
 */
export function installStubGateway(
  replies: string | readonly string[],
  options: StubGatewayOptions = {},
): StubGatewayCall[] {
  const gateway = stubGateway(replies, options);
  vi.stubGlobal("fetch", gateway.fetch);
  return gateway.calls;
}

/**
 * Register a fake's `restore` with the test that installed it.
 *
 * `onTestFinished` rather than `afterEach`, and the difference is what makes the
 * whole `install*` family possible: `afterEach` may only be called while a suite
 * is being COLLECTED, so a helper called from inside a test body cannot register
 * one — which is exactly where every template's stub is created, in a
 * `stubProvider()` called by the test that needs it. `onTestFinished` registers
 * against the test currently running, and runs in reverse order, so a spec that
 * installs three fakes unwinds them in the order it would have written by hand.
 *
 * The registry those specs kept instead — `const restores: (() => void)[]` plus
 * an `afterEach` that splices it — is the thing this replaces; one file had
 * three of them.
 *
 * Called from a hook or a test body. Outside both there is no test to attach to,
 * and vitest says so; a fake installed at module scope has module lifetime and
 * belongs in `sdk/testing.ts`'s framework-agnostic form, where the caller owns
 * the `restore` explicitly.
 */
function restoreAfterThisTest(restore: () => void): void {
  onTestFinished(restore);
}

/**
 * Publish an in-memory upload store, restored when this test finishes.
 *
 * `stubUploads` with the bookkeeping done — see it for what the store
 * serves, why writes are opt-in, and why the minted ids count up.
 *
 * @example
 * ```ts no-check
 * import { installStubUploads } from "@alexkroman1/aai/testing/vitest";
 *
 * test("the step reads the recording it was given", async () => {
 *   const uploads = installStubUploads({ upl_1: new Uint8Array(5000) }, { writable: true });
 *   await ingest("upl_1");
 *   expect(uploads.writes).toHaveLength(1);
 * });
 * ```
 *
 * @public
 */
export function installStubUploads(
  files: Readonly<Record<string, StubUpload>>,
  options: StubUploadsOptions = {},
): StubUploads {
  const uploads = stubUploads(files, options);
  restoreAfterThisTest(uploads.restore);
  return uploads;
}

/**
 * Publish a fake `stepFetch`, restored when this test finishes.
 *
 * `stubStepFetch` with the bookkeeping done — see it for why a step's HTTP
 * goes through a published slot rather than the global, and what the recorded
 * request carries.
 *
 * @param answer - Called per request. Defaults to an empty `200`.
 *
 * @public
 */
export function installStubStepFetch(
  answer?: (request: StubStepRequest) => StubStepAnswer | Promise<StubStepAnswer>,
): StubStepFetch {
  const fetched = answer ? stubStepFetch(answer) : stubStepFetch();
  restoreAfterThisTest(fetched.restore);
  return fetched;
}

/**
 * Capture what a step narrates and emits, restored when this
 * test finishes.
 *
 * `stubReporter` with the bookkeeping done — see it for why `stepReport()` and
 * `stepEmit()` are separated the way the streams are.
 *
 * @public
 */
export function installStubReporter(): StubReporter {
  const reported = stubReporter();
  restoreAfterThisTest(reported.restore);
  return reported;
}

/**
 * Publish a synthesizer that records what it was asked to say, restored when
 * this test finishes.
 *
 * `stubSpeech` with the bookkeeping done — see it for the call log's
 * shape, the silence it answers with, and how to make it fail instead.
 *
 * @public
 */
export function installStubSpeech(options: StubSpeechOptions = {}): StubSpeech {
  const speech = stubSpeech(options);
  restoreAfterThisTest(speech.restore);
  return speech;
}

/**
 * Answer AssemblyAI's transcription endpoints in memory, restored when this test
 * finishes.
 *
 * `stubTranscribe` with the bookkeeping done — see it for the four legs it
 * routes, why a refusal is staged as an HTTP status rather than as a
 * `TranscribeError`, and why it takes an `otherwise` handler.
 *
 * @public
 */
export function installStubTranscribe(options: StubTranscribeOptions = {}): StubTranscribe {
  const provider = stubTranscribe(options);
  restoreAfterThisTest(provider.restore);
  return provider;
}

/**
 * What {@link installStubWorkflows} answers each read with.
 *
 * Every field has a default, so `installStubWorkflows()` is a client whose reads all
 * answer "nothing has run" — which is the arm a `*_status` tool branches on
 * first and the one most specs of one want.
 *
 * @public
 */
export type StubWorkflowsOptions = {
  /**
   * The runs `get`, `find` and `recent` answer from — `get` with the first,
   * the other two with the whole list. One list rather than three, because a
   * spec asserting what a tool REPORTS is describing one world, and three
   * fixtures that can disagree about it is a way to write a passing test for a
   * state the platform cannot produce. Build them with `createRunSnapshot`.
   */
  runs?: readonly WorkflowRunSnapshot[];
  /**
   * Workflow names `listing()` reports, in order — normally the one the agent
   * under test declares. Defaults to none, i.e. an agent declaring no workflow.
   */
  names?: readonly string[];
  /** What `start` resolves with. Defaults to `"wrun_stub"`. */
  runId?: string;
  /**
   * What `lastLine` resolves with. Defaults to `undefined`, which means "the
   * run has written nothing yet" — the arm a progress tool branches on, and the
   * reason this has a default rather than being left to reject.
   */
  lastLine?: unknown;
};

/**
 * A `ctx.workflows` whose reads answer from one fixture and whose every method
 * is a `vi.fn`.
 *
 * `createStubWorkflows` (`@alexkroman1/aai/testing`) is the framework-agnostic
 * base: it REJECTS every method, so a tool reaching for one the spec did not
 * stub says so. That is the right default and it is not the shape a spec of a
 * workflow-driving agent wants, because such a tool reads two or three methods
 * per call and asserts on `start`. Both shipped workflow templates therefore
 * opened with the same fifteen lines — a `vi.fn` per method, answering from one
 * `runs` array — byte-identical apart from the workflow name in `listing`.
 *
 * **It is on this subpath because `vi.fn` is the content.** The methods have to
 * be spies: a spec asserts `expect(workflows.start).toHaveBeenCalledWith(def,
 * input)` and re-points one per test with
 * `vi.mocked(workflows.lastLine).mockResolvedValue("…")`. A plain-function
 * version would be a different helper that neither template could use.
 *
 * **What it does NOT answer is deliberate.** `stream`, `streamTail`, `signal`
 * and `publicWebhookUrl` fall through to the rejecting base, because a tool
 * reading a progress channel by hand is the hazard `lastLine` exists to remove
 * — see `WorkflowClient.lastLine`, where composing `streamTail` + `stream` in
 * the wrong order waits forever with no error. A spec that really is testing
 * one of those overrides it, which reads as the deliberate act it is.
 *
 * Spread it to replace a method for one test: `{ ...installStubWorkflows(), signal }`.
 *
 * @example
 * ```ts
 * import { createRunSnapshot, createToolContext } from "@alexkroman1/aai/testing";
 * import { installStubWorkflows } from "@alexkroman1/aai/testing/vitest";
 *
 * const workflows = installStubWorkflows({
 *   names: ["recap"],
 *   runs: [createRunSnapshot({ workflow: "recap", status: "running" })],
 * });
 * const ctx = createToolContext({ workflows });
 * ```
 *
 * @public
 */
export function installStubWorkflows(options: StubWorkflowsOptions = {}): WorkflowClient {
  const runs = options.runs ?? [];
  const runId = options.runId ?? "wrun_stub";
  const names = options.names ?? [];
  const lastLine = options.lastLine;
  return createStubWorkflows({
    start: vi.fn(async () => runId),
    // The first of the same list the lookups answer from, so "the run this
    // session started" and "this session's runs" cannot disagree.
    get: vi.fn(async () => runs[0]),
    find: vi.fn(async () => [...runs]),
    recent: vi.fn(async () => [...runs]),
    cancel: vi.fn(async () => true),
    // `0` woken: a `wakeUp` that reports work done is the interesting case and
    // the one a spec overrides, so the default is the quiet answer.
    wakeUp: vi.fn(async () => 0),
    lastLine: vi.fn(async () => lastLine),
    listing: vi.fn(() => names.map((name) => ({ name }))),
  });
}
