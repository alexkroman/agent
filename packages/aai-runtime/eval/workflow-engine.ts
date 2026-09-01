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
 * The tier that DOES exercise the real thing is `aai-cli`'s
 * `dev-workflow.scenario.test.ts` — a built project, a real world, a real queue,
 * a run that really suspends and resumes.
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
 * | `signal` | `false` | `createHook()` THROWS untransformed, so no run can be listening |
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
 * credentials through `publishStepEnv`, and a body sleeps through a
 * `Symbol.for("WORKFLOW_SLEEP")` global the DevKit's `sleep()` looks for —
 * absent, it throws "`sleep()` can only be called inside a workflow function",
 * which is what makes a body like `link-digest`'s undrivable without this. Two
 * more are filled only when a caller supplies one
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
  publishStepReporter,
  type SpeechSynthesizer,
  type StepFetch,
} from "@alexkroman1/aai/host-internal";
import { errorMessage, isRecord } from "@alexkroman1/aai/utils";
import type { WorkflowCtx, WorkflowDef, WorkflowRunStatus } from "@alexkroman1/aai/workflow-api";
import type { WdkAdapter, WdkRunRecord } from "../workflow-wdk-types.ts";

/**
 * The DevKit's own slot for the durable `sleep`.
 *
 * `Symbol.for('WORKFLOW_SLEEP')` — read out of `@workflow/core`'s `symbols.js`,
 * where `sleep()` looks it up on `globalThis` and throws when it is empty. Named
 * by its string rather than imported because the import that would give it to us
 * is `@workflow/core/dist/symbols.js`, a deep path into a dependency's internals
 * that no export map offers.
 */
const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");

/** The shape the sleep slot is read and written through. */
type SleepSlot = { [WORKFLOW_SLEEP]?: (param: string | number | Date) => Promise<void> };

/** One chunk `emit()` wrote during a run, and the stream it named. */
export type EvalEmitted = {
  /** The stream the step named. */
  readonly namespace: string;
  /** The value, exactly as the step passed it. */
  readonly chunk: unknown;
};

/**
 * One durable `sleep()` a body asked for — and did NOT take.
 *
 * Recorded rather than waited out, because a suspension is the thing this engine
 * cannot reproduce and a real wait would only make a case slow while proving
 * nothing extra: `link-digest`'s ten seconds and the six hours its own comment
 * says the mechanism is identical at differ by nothing that runs here. What a
 * case CAN assert is that the body asked, and for how long.
 */
export type EvalSleep = {
  /** Exactly what the body passed `sleep()` — `"10 seconds"`, a number of ms, a date. */
  readonly duration: string | number | Date;
};

/** One run this engine executed, as the engine records it. */
export type EvalRunRecord = {
  readonly runId: string;
  /** The key this workflow is declared under in `agent({ workflows })`. */
  readonly workflowName: string;
  status: WorkflowRunStatus;
  readonly createdAt: number;
  output?: unknown;
  error?: { message: string };
  /** Lines this run's steps wrote with `report()`, oldest first. */
  readonly reported: string[];
  /** Chunks this run's steps wrote with `emit()`, oldest first. */
  readonly emitted: EvalEmitted[];
  /** Durable sleeps the body asked for — see {@link EvalSleep}. */
  readonly slept: EvalSleep[];
  /** Wall clock from `start()` to the body settling, once it has. */
  elapsedMs?: number;
  /**
   * Resolves when the body has settled, whatever it did. Never rejects.
   *
   * Writable because it cannot be built with the record: the body needs the
   * record to narrate into, so the promise is assigned the statement after
   * `start` creates one — synchronously, before any caller can read it.
   */
  settled: Promise<void>;
};

/**
 * A workflow body as this engine calls it.
 *
 * `WorkflowDef`'s default schema parameter makes `run` take
 * `Record<string, unknown>` — the validated input — so this is that signature
 * named, and it is what lets the engine call a body without a cast.
 */
type EvalBody = (input: Record<string, unknown>, ctx: WorkflowCtx) => Promise<unknown> | unknown;

/** What {@link createEvalWorkflowEngine} takes. */
export type EvalWorkflowEngineOptions = {
  /** The agent's declared workflows, keyed as `agent({ workflows })` keys them. */
  readonly workflows: Readonly<Record<string, WorkflowDef>>;
  /**
   * The agent env a step reads with `stepEnv`/`requireStepEnv`.
   *
   * Published rather than left to `process.env`, which is what an unpublished
   * slot falls back to: publishing is what makes a step read exactly the keys the
   * agent declares, in an eval as in a deployment.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * A `stepFetch` to publish for this app's steps. Nothing is published by
   * default, which means a step's HTTP falls back to `globalThis.fetch`.
   *
   * **Taken as a VALUE rather than built here, and that is a graph decision
   * rather than a style one.** `createStepFetch` reaches `undici`, and naming it
   * from this module put the runtime's whole step graph into the program of
   * every package whose eval file imports `/eval/vitest` — which is
   * `aai-templates`, where it failed on an unrelated `BodyInit` mismatch under
   * `exactOptionalPropertyTypes`. That is the hazard
   * `packages/aai-runtime/CLAUDE.md` records for `host-internal`, arriving by a
   * new route. A host that wants the pooled HTTP/1.1 fetch passes its own; a
   * template eval does not need one.
   *
   * The cost, stated: `globalThis.fetch` offers `h2` in ALPN, so a WIDE live
   * fan-out through it can collect stream resets a pooled HTTP/1.1 fetch would
   * not (`sdk/step-fetch.ts` has the measurements). An eval is not where a
   * fan-out's concurrency is measured, and the upside is that BOTH published
   * fakes work — `installStubGateway` over the global, and
   * `installStubStepFetch` / `installStubTranscribe` over the slot.
   */
  readonly stepFetch?: StepFetch | undefined;
  /**
   * A speech synthesizer to publish, for a flow whose step calls `stepSpeak`.
   *
   * Nothing by default, so an unpublished slot fails by name — which is the
   * SDK's own behaviour and the right one: there is no global synthesizer to
   * fall back to. A case supplies `installStubSpeech`
   * (`@alexkroman1/aai/testing/vitest`); a host wanting the real socket passes
   * `speakOverWebSocket`, which is not named here for the same graph reason as
   * {@link EvalWorkflowEngineOptions.stepFetch}.
   */
  readonly speech?: SpeechSynthesizer | undefined;
};

/** The engine, and the two things a caller does with it. */
export type EvalWorkflowEngine = {
  /** Hand this to `createWorkflowClient` as its `wdk`. */
  readonly adapter: WdkAdapter;
  /** The run this engine executed under `runId`, if it executed one. */
  record(runId: string): EvalRunRecord | undefined;
  /** Every run, oldest first. */
  records(): readonly EvalRunRecord[];
  /**
   * Unpublish the step slots.
   *
   * Never optional: the slots are process-global, so an engine left installed
   * answers the NEXT case's steps — the cross-file leak `stubUploads` carries the
   * same warning about. Never rejects.
   */
  release(): Promise<void>;
};

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
  // Both are caller-supplied and both default to NOTHING, which is what keeps
  // `undici` and `ws` out of the module graph an eval file drags into its own
  // package's program. See the two option docs.
  if (opts.speech) publishSpeechSynthesizer(opts.speech);
  if (opts.stepFetch) publishStepFetch(opts.stepFetch);

  // Saved and restored rather than deleted, so an engine opened inside something
  // that had already installed a sleep (a future harness, a nested case) does not
  // silently take it away.
  const globals = globalThis as SleepSlot;
  const priorSleep = globals[WORKFLOW_SLEEP];
  globals[WORKFLOW_SLEEP] = (duration) => {
    current.getStore()?.slept.push({ duration });
    return Promise.resolve();
  };

  let sequence = 0;

  function toWdkRecord(record: EvalRunRecord): WdkRunRecord {
    return {
      runId: record.runId,
      workflowName: record.workflowName,
      status: record.status,
      createdAt: record.createdAt,
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
      step: async (_name, fn) => await fn(),
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

  /** WDK's `startIndex`: absent is the whole stream, negative counts back. */
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
      // Unpublished unconditionally: a slot this call did not fill may still
      // hold a PREVIOUS engine's value, and leaving one published is the
      // cross-file leak `stubUploads` carries the same warning about.
      publishSpeechSynthesizer(undefined);
      publishStepFetch(undefined);
      if (priorSleep === undefined) delete globals[WORKFLOW_SLEEP];
      else globals[WORKFLOW_SLEEP] = priorSleep;
      // A caller-supplied fetch is the CALLER's to close: this call did not open
      // its pool and cannot know who else holds it.
      return Promise.resolve();
    },
  };
}
