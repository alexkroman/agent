// Copyright 2026 the AAI authors. MIT license.
/**
 * The in-process engine an eval's workflow runs execute on — and it is NOT
 * durable. Read that first, because everything else here follows from it.
 *
 * ## What this is, and the one thing it can never be
 *
 * A `"use workflow"` body is only durable after the Workflow DevKit's builder
 * has transformed it: the transform is what turns each `"use step"` declaration
 * into a dispatcher, and the queue behind that dispatcher is what journals a
 * result, replays a resume and retries a failure. An eval imports the body
 * through a test runner with no bundler in the path, so **the body is an
 * ordinary async function and its steps are ordinary calls**. There is no
 * journal, no replay, no retry, no suspension, and no `ReplayDivergenceError`.
 * `def.run.workflowId` is not even set — the compiler is what attaches it, which
 * is why {@link createEvalWorkflowEngine} has to attach a synthetic one before
 * the real client will start anything.
 *
 * So what an eval written on this measures is what the body DOES: which steps
 * run, in what order, what they ask a provider, what the run returns, and what it
 * narrated on the way. What it cannot measure is every property the word
 * "durable" refers to. Do not name or report a case here in a way that implies
 * one — the same rule `eval/fake-speech.ts` states at the audio boundary, for
 * the same reason: the seam is where a reader forgets.
 *
 * The tier that DOES exercise the real thing end to end is `aai-cli`'s
 * `dev-workflow.scenario.test.ts` — a built project, a real world, a real queue,
 * a run that really suspends and resumes. One tier below it, and reachable from
 * an ordinary unit spec, is `runWorkflow` from
 * `@alexkroman1/aai-runtime/testing`: the real replay engine over a memory
 * journal, which is enough for a suspension, a resume, a retry, a signal and a
 * dead worker. What it does not carry is an LLM or the assertion readers below,
 * which is why an EVAL still wants this engine — the two answer different
 * questions about the same body.
 *
 * ## What IS the code a deployment runs
 *
 * Everything above the engine. This module implements {@link WdkAdapter} — the
 * seam `workflow-client.ts` was already written against so its own specs need no
 * world — and `openEvalWorkflows` hands it to the real
 * `createWorkflowClient`. So the input validation, the def→name mapping, the
 * correlation-key index, the snapshot discriminated union, `find`/`recent`'s
 * bounded reads and `lastLine`'s tail-first rule are all the production
 * implementations, unchanged.
 *
 * Four adapter methods have no honest in-process answer, and each says so rather
 * than pretending:
 *
 * | method | here | why |
 * | --- | --- | --- |
 * | `cancel` | marks the run cancelled; the body keeps going | there is no queue to stop delivering to |
 * | `wakeUp` | `0` | a sleep is skipped, not suspended — nothing is asleep to wake |
 * | `ctx.waitFor` | a TIMED wait resolves `undefined`; an unbounded one rejects | a deadline that nobody answered is an honest outcome; an open wait has none |
 * | `signal` | `false` | nothing here registers a waitpoint, so no run is ever listening for one |
 * | `readOutput` | the value the body returned | no serialization round trip, so a value a real journal would refuse passes here |
 *
 * **And a step's `maxRetries` is INERT**, which is the one consequence worth
 * saying twice because it shows up as a flaky eval rather than as a missing
 * feature. There is no interception point: an untransformed body calls
 * `await fetchArticle(url)` directly, so nothing sits between the body and its
 * step to count an attempt. A rate limit a deployed run would ride out on the
 * provider's own `Retry-After` therefore FAILS an eval run — measured against
 * the live LLM gateway, which answered `429` to a sixth run inside three
 * minutes. That is the eval tier's noisy-instrument rule arriving from a new
 * direction: one live failure is a question, not a verdict. Read the run's
 * `error` before believing it.
 *
 * ## The published slots ARE the observable surface
 *
 * Three are always filled: a step narrates through `publishStepReporter`, reads
 * credentials through `publishStepEnv`, and reads its own attempt through
 * `publishStepInfoReader` — which answers a first-and-only attempt, because
 * nothing here replays and a step that degrades on its last try must not be
 * measured on that branch. What makes a body like
 * `link-digest`'s drivable at all. A body's WAITS need no slot — `ctx.sleep` and
 * `ctx.waitFor` are `evalCtx`'s to answer, where the DevKit's `sleep()` looked
 * for a `Symbol.for("WORKFLOW_SLEEP")` global and threw without one. Two more are
 * filled only when a caller supplies one
 * ({@link EvalWorkflowEngineOptions.stepFetch}, `.speech`), and both are
 * unpublished on release either way — a slot this call left empty may hold a
 * PREVIOUS engine's value.
 *
 * Every one of them is process-global and publishing REPLACES, so one engine at a
 * time — the same constraint `installFakeSpeech` carries, and the reason
 * {@link EvalWorkflowEngine.release} is not optional.
 *
 * Narration is attributed to a run with an `AsyncLocalStorage`, which is the only
 * thing that can do it: `report()` takes no run id (a real step is dispatched
 * with one), and a fan-out has several steps narrating at once.
 *
 * @module
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  publishSpeechSynthesizer,
  publishStepEnv,
  publishStepFetch,
  publishStepInfoReader,
  publishStepReporter,
} from "@alexkroman1/aai/host-internal";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import type {
  StepOptions,
  WaitForOptions,
  WaitForSchemaOptions,
  WorkflowCtx,
  WorkflowDef,
} from "@alexkroman1/aai/workflow-api";
import { checkedStepOutput } from "../workflow-replay-schema.ts";
import type { WdkAdapter, WdkRunRecord } from "../workflow-wdk-types.ts";

import type {
  EvalBody,
  EvalRunRecord,
  EvalWorkflowEngine,
  EvalWorkflowEngineOptions,
} from "./workflow-engine-types.ts";

// Every type this engine takes or records lives one file over — see that module's
// doc for the seam. Re-exported rather than reached through a second import path,
// because they are part of THIS module's surface: `eval-barrel.ts` publishes them
// from here.
export type {
  EvalEmitted,
  EvalRunRecord,
  EvalSleep,
  EvalWorkflowEngine,
  EvalWorkflowEngineOptions,
} from "./workflow-engine-types.ts";

/** Ids are per engine, so a case can assert on the string a tool was handed. */
let engines = 0;

/**
 * Build the in-process engine, publishing what a step reads.
 *
 * **This used to stamp a synthetic `workflowId` onto every body, and the fact
 * that it no longer has to is the shape of the DevKit removal.**
 * `createWorkflowClient` read `def.run.workflowId` and refused without one,
 * because on every real path a compile-time transform had attached it — so an
 * eval, which imports a body through a test runner with no bundler in the path,
 * had to forge one and give it back on `release()`. A workflow is identified by
 * its declared key now, which an eval has for free.
 *
 * @see the module doc for what an eval run does NOT exercise.
 */
export function createEvalWorkflowEngine(opts: EvalWorkflowEngineOptions): EvalWorkflowEngine {
  engines += 1;
  const prefix = `eval-${engines}`;
  const runs = new Map<string, EvalRunRecord>();
  const byName = new Map<string, { name: string; def: WorkflowDef }>();

  for (const [name, def] of Object.entries(opts.workflows)) {
    // FIRST key wins, matching `createWorkflowClient`'s own index: the same def
    // declared under two names is legitimate and a run of it carries no trace of
    // which one a caller meant, so both sides have to pick the same one.
    if (!byName.has(name)) byName.set(name, { name, def });
  }

  // The narration channel. `report()` and `emit()` carry no run id — a real step
  // is dispatched with one — so the only thing that can attribute a line is the
  // async context the body is running in.
  const current = new AsyncLocalStorage<EvalRunRecord>();
  publishStepReporter((chunk, options) => {
    const record = current.getStore();
    if (record === undefined) return;
    if (options?.namespace === undefined) record.reported.push(String(chunk));
    else record.emitted.push({ namespace: options.namespace, chunk });
  });
  publishStepEnv(opts.env);
  // A body driven here is not REPLAYED, so no step of it is ever retried and the
  // honest answer to `stepInfo()` is a first-and-only attempt. Filled rather
  // than left empty because unfilled means `undefined`, which a body reads as
  // "no run at all" — so a step that degrades on its last attempt would take
  // that branch in an eval and be measured on the path a real run only reaches
  // when something has gone wrong. `maxAttempts: 1` is the truth here: this
  // engine has no retry to spend, which is the same limit
  // {@link EvalWorkflowEngineOptions} states about `maxRetries` being INERT.
  publishStepInfoReader(() =>
    current.getStore() === undefined
      ? undefined
      : { name: "eval", key: "eval#0", attempt: 1, maxAttempts: 1, isLastAttempt: true },
  );
  // Both are caller-supplied and both default to NOTHING, which is what keeps
  // `undici` and `ws` out of the module graph an eval file drags into its own
  // package's program. See the two option docs.
  if (opts.speech) publishSpeechSynthesizer(opts.speech);
  if (opts.stepFetch) publishStepFetch(opts.stepFetch);

  let sequence = 0;

  function toWdkRecord(record: EvalRunRecord): WdkRunRecord {
    return {
      runId: record.runId,
      workflowName: record.workflowName,
      status: record.status,
      createdAt: record.createdAt,
      // Both payload fields ride the record, mirroring the production engine's
      // `toWdkRecord`: a snapshot reads `output` from here rather than paying a
      // second `readOutput`, so an engine that dropped it would report every
      // completed run as having returned nothing.
      ...(record.status === "completed" ? { output: record.output } : {}),
      ...(record.status === "failed" && record.error ? { error: record.error } : {}),
    };
  }

  /**
   * The `ctx` a body is handed here — and the one method on it does NOT journal.
   *
   * `step(name, fn)` calls `fn` and returns what it returns. There is no
   * memoization, because nothing replays; no attempt counting, because nothing
   * retries; and no persistence, because there is no journal to persist to. It
   * is a pass-through that exists so the body can be WRITTEN the way a deployed
   * body is written.
   *
   * That is the same limitation the module doc states, moved to where it is now
   * VISIBLE. Under the DevKit it was invisible and accidental — an untransformed
   * `"use step"` is just a directive nobody read, so the body silently degraded
   * to ordinary calls and only prose said so. Here the degradation is a function
   * a reader can see the whole of, which is strictly better even though it
   * measures exactly as much.
   */
  function evalCtx(record: EvalRunRecord): WorkflowCtx {
    return {
      runId: record.runId,
      workflow: record.workflowName,
      // The parameters are annotated because `WorkflowCtx.step` is OVERLOADED —
      // a schema selects a second signature — and TypeScript contextually types
      // a function expression from one signature only. The pass-through is
      // unchanged; what it gained is that a declared `schema` is still CHECKED
      // here, which costs nothing and keeps a case from passing on a shape a
      // deployed run would refuse. (It is the write side only: there is no
      // journal here, so there is no read side to disagree with it.)
      step: async (name: string, fn: () => unknown, options?: StepOptions) =>
        await checkedStepOutput(options?.schema, name, await fn()),
      // LIVE, not journaled — the same pass-through `step` is, and for the same
      // reason: there is no journal here, so there is nothing to answer a second
      // walk from and no second walk to answer. A case that needs a FIXED clock
      // or a fixed id wants `createWorkflowCtx` from `@alexkroman1/aai/testing`,
      // which freezes all three; what this preserves is that the body can be
      // WRITTEN the way a deployed body is written.
      now: async () => Date.now(),
      random: async () => Math.random(),
      uuid: async () => crypto.randomUUID(),
      // RECORDED, not taken — the same treatment the DevKit's `sleep()` gets
      // through the global slot above, and for the same reason: a suspension is
      // the one thing this engine cannot reproduce, and really waiting would
      // make a case slow while proving nothing extra. `link-digest`'s ten
      // seconds and the six hours its own comment says are mechanically
      // identical differ by nothing that runs here. What a case CAN assert is
      // that the body asked, and for how long.
      sleep: async (label, until) => {
        record.slept.push({ label, duration: until });
      },
      // REFUSED, and named. A hook is the one thing on `WorkflowCtx` this engine
      // cannot fake: a sleep can be skipped because the body continues either
      // way, but a `waitFor` is defined by what the SIGNALLER sends, and
      // inventing a payload would evaluate a run nobody could have produced.
      // Under the DevKit this was the same gap arriving less legibly —
      // `createHook()` threw from inside `@workflow/core` with a message about
      // workflow functions — and `recap-workflow`'s retention gate is still the
      // case it costs. The seam that would close it is an
      // `openEvalWorkflows({ hooks })` supplying payloads by token; it is not
      // built, and this message is what says so.
      // Both option bags, because a wait may carry a schema and no deadline at
      // all. It is the DEADLINE that decides the branch below, never the mere
      // presence of options — a schema does not make a wait bounded.
      waitFor: (_token: string, waitOptions?: WaitForOptions | WaitForSchemaOptions) =>
        // A wait with a DEADLINE has an honest answer here — nobody signalled, so
        // the window closed — and it is the branch a retention gate or an
        // approval window takes when no one replies. Only an UNBOUNDED wait has
        // nothing this engine can say. The schema is never consulted: there is
        // no payload to check, which is the same rule the real engine follows.
        waitOptions !== undefined && "timeoutMs" in waitOptions
          ? Promise.resolve(undefined)
          : Promise.reject(
              new Error(
                "ctx.waitFor is not available in an eval run: a hook's payload comes from " +
                  "outside the run, so there is nothing here to send one. Drive the run " +
                  "through the workflow HTTP API in a scenario test instead.",
              ),
            ),
    };
  }

  /**
   * Run the body to completion, recording what it did.
   *
   * Never rejects — the failure is the run's, and a rejection here would become
   * an unhandled one, `start()` having already resolved with the id.
   */
  async function execute(record: EvalRunRecord, body: EvalBody, input: unknown): Promise<void> {
    const startedAt = Date.now();
    try {
      // A validated input is an object — `ToolInputSchema`'s output type says so
      // — and a workflow declaring no schema is handed whatever the caller
      // passed, which its body is free to ignore. `{}` for that case rather than
      // `undefined`, because the parameter is typed as present.
      const output = await body(isRecord(input) ? input : {}, evalCtx(record));
      record.elapsedMs = Date.now() - startedAt;
      // A cancelled run keeps its status: there is no queue to stop delivering
      // to, so the body ran on regardless, and reporting `completed` would claim
      // the cancel did something it did not.
      if (record.status === "cancelled") return;
      record.status = "completed";
      record.output = output;
    } catch (err: unknown) {
      record.elapsedMs = Date.now() - startedAt;
      if (record.status === "cancelled") return;
      record.status = "failed";
      record.error = { message: errorMessage(err) };
    }
  }

  /** The chunks one stream of a run holds — `report`'s, or a named `emit`'s. */
  function chunksOf(record: EvalRunRecord, namespace: string | undefined): unknown[] {
    if (namespace === undefined) return [...record.reported];
    return record.emitted.filter((one) => one.namespace === namespace).map((one) => one.chunk);
  }

  /**
   * `startIndex`, with the SAME two readings the real store gives it.
   *
   * Absent is the whole stream, negative counts back from the end (`-1` is the
   * newest alone), and a non-negative value is an INCLUSIVE floor — the first
   * index the reader wants. `workflow-streams.ts`'s `read` is the definition and
   * its own doc carries the argument, which is short: every consumer of this
   * cursor counts what it consumed and re-sends that count, and a count IS the
   * first unread index.
   *
   * This briefly read it EXCLUSIVELY, to match a production store that was
   * exclusive at the time. That made the two implementations of one `WdkAdapter`
   * agree — on the wrong semantic — which is worth recording, because agreement
   * between two implementations is exactly what a differential spec looks for and
   * it is not the same claim as either of them being right. The oracle that
   * settled it is `workflow-stream-cursor.test.ts`: it holds this adapter against
   * the memory store AND both against a poll loop that has to reconstruct its
   * own log, and only the third property could tell the two candidates apart.
   *
   * Indices here are array positions because nothing drops from the front; the
   * real store subtracts its first index for the same arithmetic.
   */
  function fromIndex(chunks: readonly unknown[], startIndex: number | undefined): unknown[] {
    if (startIndex === undefined) return [...chunks];
    if (startIndex < 0) return chunks.slice(Math.max(0, chunks.length + startIndex));
    return chunks.slice(startIndex);
  }

  const adapter: WdkAdapter = {
    start(workflowName, args) {
      const entry = byName.get(workflowName);
      if (!entry) {
        return Promise.reject(
          new Error(
            `eval workflow engine has no workflow named ${JSON.stringify(workflowName)}; ` +
              `it serves ${[...byName.keys()].join(", ") || "(none)"}`,
          ),
        );
      }
      sequence += 1;
      const runId = `${prefix}-run-${sequence}`;
      const record: EvalRunRecord = {
        runId,
        workflowName,
        status: "running",
        createdAt: Date.now(),
        reported: [],
        emitted: [],
        slept: [],
        // Replaced on the next statement — see the field's own doc.
        settled: Promise.resolve(),
      };
      runs.set(runId, record);
      // `current.run` is what puts the record in scope for every `report()` the
      // body's steps make, including the ones a fan-out makes concurrently.
      record.settled = current.run(record, () => execute(record, entry.def.run, args[0]));
      return Promise.resolve(runId);
    },

    getRun(runId) {
      const record = runs.get(runId);
      return Promise.resolve(record ? toWdkRecord(record) : undefined);
    },

    listRuns(workflowName, limit) {
      // Newest first, which is what `recent` promises.
      const matching = [...runs.values()]
        .filter((record) => record.workflowName === workflowName)
        .reverse()
        .slice(0, limit);
      return Promise.resolve(matching.map(toWdkRecord));
    },

    cancel(runId) {
      const record = runs.get(runId);
      if (record?.status !== "running") return Promise.resolve(false);
      // The STATUS only. See the module doc's table: nothing here can stop a
      // function that is already executing, so a case must not read a `true` as
      // "the work stopped".
      record.status = "cancelled";
      return Promise.resolve(true);
    },

    wakeUp() {
      // A sleep is SKIPPED here rather than suspended, so nothing is ever asleep
      // to interrupt. `0` is the answer a live run that is not sleeping gives,
      // which is the same fact.
      return Promise.resolve(0);
    },

    signal() {
      // `createHook()` throws untransformed — the DevKit's non-workflow build
      // does nothing else — so no body running here can be listening on a token.
      // `false` is what the real adapter answers for a token nobody holds.
      return Promise.resolve(false);
    },

    streamTail(runId, options) {
      const record = runs.get(runId);
      if (!record) return Promise.resolve(-1);
      return Promise.resolve(chunksOf(record, options.namespace).length - 1);
    },

    readStream(runId, options) {
      const record = runs.get(runId);
      const chunks = record
        ? fromIndex(chunksOf(record, options.namespace), options.startIndex)
        : [];
      // Already-written chunks and then END, unlike a real progress channel,
      // which is never closed — see `WdkAdapter.streamTail`. A reader here
      // therefore terminates without needing the tail, and one written against
      // the tail still works, which is what keeps `lastLine` honest.
      return new ReadableStream<unknown>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
    },

    readOutput(runId) {
      return Promise.resolve(runs.get(runId)?.output);
    },
  };

  return {
    adapter,
    record: (runId) => runs.get(runId),
    records: () => [...runs.values()],
    release() {
      publishStepReporter(undefined);
      publishStepEnv(undefined);
      publishStepInfoReader(undefined);
      // Unpublished unconditionally: a slot this call did not fill may still
      // hold a PREVIOUS engine's value, and leaving one published is the
      // cross-file leak `stubUploads` carries the same warning about.
      publishSpeechSynthesizer(undefined);
      publishStepFetch(undefined);
      // A caller-supplied fetch is the CALLER's to close: this call did not open
      // its pool and cannot know who else holds it.
      return Promise.resolve();
    },
  };
}
