// Copyright 2026 the AAI authors. MIT license.
/**
 * Driving a WORKFLOW from an eval: start a run, wait for it, read what it did.
 *
 * `eval/session.ts` answers "given this utterance, did the agent do the right
 * thing". This answers the same question for the other kind of agent — a
 * `workflowApp()`, which has no session, no microphone and no model in its
 * config, and whose whole product is a durable run. Nothing in the SDK could
 * evaluate one: a page starts a run over HTTP against a deployed agent, and a
 * spec drives the exported steps one at a time.
 *
 * ```ts no-check
 * import { openEvalWorkflows } from "@alexkroman1/aai-runtime/eval";
 * import agentDef, { digest } from "./agent.ts";
 *
 * const app = openEvalWorkflows({ agent: agentDef });
 * try {
 *   const run = await app.run(digest, { url: "https://example.test/post" });
 *   expect(run.status).toBe("completed");
 *   expect(run.output?.headline).toMatch(/otter/i);
 *   expect(run.reported.join(" ")).toContain("Reading");
 * } finally {
 *   await app.close();
 * }
 * ```
 *
 * In a vitest project reach for `describeWorkflowEval` from
 * `@alexkroman1/aai-runtime/eval/vitest` instead, which owns the mode gate and
 * the per-case app.
 *
 * ## It is NOT a durability test, and that is the load-bearing sentence
 *
 * The run really executes: the real body, the real steps, the real provider
 * calls, the real narration. It executes as an ORDINARY ASYNC FUNCTION, because
 * a `"use workflow"` body is only durable once the Workflow DevKit's builder has
 * transformed it and an eval imports it through a test runner with no bundler in
 * the path. So there is no journal, no replay, no suspension, no per-step retry.
 * `eval/workflow-engine.ts` carries the full account, including the four
 * `WorkflowClient` methods that therefore have no honest answer. A case here may
 * not be described as covering replay, resume or retry; `aai-cli`'s
 * `dev-workflow.scenario.test.ts` is the tier that does.
 *
 * What IS the production code is everything above the engine — this builds the
 * real `createWorkflowClient` over the real memory key store, so the schema
 * validation, the name mapping, the `find`-by-key index and the snapshot union a
 * case reads are the ones a deployment runs.
 *
 * ## A provider is the CASE's business
 *
 * A step that reaches a model, a transcription endpoint or an upload store reads
 * a published slot, and the fakes for all of them are already published:
 * `installStubUploads`, `installStubStepFetch`, `installStubTranscribe`,
 * `installStubSpeech`, `installStubGateway` on
 * `@alexkroman1/aai/testing/vitest`. Nothing is reinvented here, and nothing is
 * installed on a case's behalf — a case is handed the mode and decides, because
 * a harness that guessed would be choosing which provider calls a live eval
 * really makes.
 *
 * Nothing is published for a step's HTTP either, so `stepFetch` falls back to
 * `globalThis.fetch` and BOTH published fakes work — `installStubGateway` over
 * the global, `installStubStepFetch` / `installStubTranscribe` over the slot.
 * {@link EvalWorkflowsOptions.stepFetch} is how a host supplies the pooled
 * HTTP/1.1 one, and says why it is a value rather than a flag.
 *
 * @module
 */

import type { AgentDef, InferSchemaOutput, ToolInputSchema } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type {
  AnyWorkflowDef,
  StartOptions,
  WorkflowClient,
  WorkflowDef,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
} from "@alexkroman1/aai/workflow-api";
import pTimeout from "p-timeout";
import { withHostCredentialFallback } from "../providers/host-env.ts";
import { requiredProviderEnvVars } from "../providers/resolve.ts";
import { type Logger, silentLogger } from "../runtime-config.ts";
import { createWorkflowClient } from "../workflow-client.ts";
import { createMemoryKeyStore } from "../workflow-keys.ts";
import { credentialVerdict } from "./_credential-verdict.ts";
import { releaseQuietly, settleAllRuns, warnOnAbandonedRuns } from "./_workflow-drain.ts";
import type { EvalCredentials } from "./session.ts";
import {
  createEvalWorkflowEngine,
  type EvalEmitted,
  type EvalRunRecord,
  type EvalSleep,
  type EvalWorkflowEngineOptions,
} from "./workflow-engine.ts";

/**
 * How long one run may take before the harness gives up on it.
 *
 * Generous next to a session turn's 90s, because a workflow is the shape of work
 * that does not fit in a turn — a fan-out over sixty segments, seven long-form
 * model calls — and the eval tier's own budget is 1800s.
 */
const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/**
 * Can this machine run workflow evals against `agent`?
 *
 * The sibling of `evalCredentials`, and it is a DIFFERENT question rather than a
 * convenience wrapper: `requiredProviderEnvVars` answers `[]` for a
 * `page: "static"` agent — correctly, since a workflow app dials no provider
 * from a session — so asking it alone reports every workflow app ready and every
 * keyless run live, and every case then fails on a 401 inside a step.
 *
 * What names a workflow app's credentials is `requiredEnv`, which is exactly why
 * `link-digest`'s own doc calls that field load-bearing in a way it is not for a
 * voice agent. So this is the union of the two, checked against the host
 * environment.
 *
 * `env` carries provider credentials plus any DECLARED `requiredEnv` name the
 * host has — declared only, matching `resolveAgentEnv`'s rule, so a step reads
 * what the agent says it needs and no unrelated shell variable reaches it.
 */
export function evalWorkflowCredentials(
  agent: AgentDef,
  hostEnv: Record<string, string | undefined> = process.env,
): EvalCredentials {
  const env: Record<string, string> = { ...withHostCredentialFallback({}, hostEnv) };
  for (const name of agent.requiredEnv ?? []) {
    const value = hostEnv[name];
    if (value !== undefined && value !== "" && env[name] === undefined) env[name] = value;
  }
  const needed = new Set([...requiredProviderEnvVars(agent), ...(agent.requiredEnv ?? [])]);
  const missing = [...needed].filter((name) => env[name] === undefined);
  return {
    env: withHostCredentialFallback(env, {}),
    ...credentialVerdict(missing),
  };
}

/** What one eval run did. */
export type EvalWorkflowRun<R = unknown> = {
  readonly runId: string;
  /** The key the workflow is declared under in `agent({ workflows })`. */
  readonly workflow: string;
  /**
   * The CORRELATION key the caller started this run under, when it named one.
   *
   * A voice tool that hands off to a run correlates it with something it can
   * find again — `ctx.sessionId`, an order id — and "did it correlate the run"
   * is a claim an eval wants to make DIRECTLY. Without this it was provable only
   * by having a later turn find the run again, which is a weaker statement
   * about a longer chain. It is the same field the production snapshot carries,
   * so a case reads what a page would.
   */
  readonly key: string | undefined;
  readonly status: WorkflowRunStatus;
  /**
   * What the body returned, for a run that completed.
   *
   * Flat and possibly `undefined` because that is what an assertion reads best;
   * {@link EvalWorkflowRun.snapshot} is the same fact as the discriminated union
   * the production client answers with, for a case that wants the narrowing.
   */
  readonly output: R | undefined;
  /** The failure message, for a run that failed. */
  readonly error: string | undefined;
  /** `status === "completed"` — the run ended on its own terms. */
  readonly completed: boolean;
  /** Every line this run's steps wrote with `report()`, oldest first. */
  readonly reported: readonly string[];
  /** Every chunk this run's steps wrote with `emit()`, oldest first. */
  readonly emitted: readonly EvalEmitted[];
  /**
   * Every durable `sleep()` the body asked for — recorded, never waited out.
   * See {@link EvalSleep}: a suspension is the thing this cannot reproduce, so
   * the honest report is what was asked for.
   */
  readonly slept: readonly EvalSleep[];
  /** Wall clock of the body, once it has settled. */
  readonly elapsedMs: number | undefined;
  /** What `ctx.workflows.get(runId)` answered — the production union. */
  readonly snapshot: WorkflowRunSnapshot<R>;
};

/** Per-run knobs. */
export type EvalRunOptions = StartOptions & {
  /** Overrides {@link DEFAULT_RUN_TIMEOUT_MS} for this run. */
  readonly timeoutMs?: number | undefined;
};

/** What {@link openEvalWorkflows} takes. */
export type EvalWorkflowsOptions = {
  /** The agent under eval — an ordinary `agent()` or `workflowApp()` definition. */
  readonly agent: AgentDef;
  /**
   * The agent env a step reads with `stepEnv` / `requireStepEnv`.
   *
   * Defaults to what {@link evalWorkflowCredentials} found on this machine, which
   * is the same trust decision `openEvalSession` makes for its provider env and
   * right for the same reason: an eval runs on the developer's box against their
   * own key. A value passed here always wins.
   */
  readonly env?: Record<string, string> | undefined;
  /**
   * A `stepFetch` to publish for this app's steps — nothing by default, so a
   * step's HTTP falls back to `globalThis.fetch`.
   *
   * Taken as a value rather than built here, and the reason is a MODULE GRAPH
   * one that a reader would otherwise undo: see
   * {@link EvalWorkflowEngineOptions.stepFetch}.
   */
  readonly stepFetch?: EvalWorkflowEngineOptions["stepFetch"];
  /**
   * A speech synthesizer to publish, for a flow whose step calls `stepSpeak` —
   * nothing by default. See {@link EvalWorkflowEngineOptions.speech}.
   */
  readonly speech?: EvalWorkflowEngineOptions["speech"];
  /** Overrides the default per-run timeout for every run of this app. */
  readonly timeoutMs?: number | undefined;
  /** Defaults to silent. Pass `consoleLogger` when diagnosing a case. */
  readonly logger?: Logger | undefined;
};

/** One open eval workflow app. */
export type EvalWorkflows = {
  /**
   * The real `ctx.workflows` for this agent, over the in-process engine.
   *
   * Hand it to `openEvalSession({ workflows })` and a voice agent's tool that
   * starts, finds or cancels a run works in an eval — which is what
   * `research-workflow` and `recap-workflow` need and could not have.
   */
  readonly client: WorkflowClient;
  /** Start a run and wait for it to settle. */
  run<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    input: InferSchemaOutput<P>,
    options?: EvalRunOptions,
  ): Promise<EvalWorkflowRun<R>>;
  run(workflow: string, input?: unknown, options?: EvalRunOptions): Promise<EvalWorkflowRun>;
  /**
   * Wait for a run somebody ELSE started — a tool, in a voice eval — and read it.
   *
   * @throws if this app never started `runId`, which is the honest answer: the
   *   engine is the only thing that can have run it.
   */
  settle<R>(
    runId: string,
    of: AnyWorkflowDef<R>,
    options?: { timeoutMs?: number | undefined },
  ): Promise<EvalWorkflowRun<R>>;
  settle(
    runId: string,
    of?: undefined,
    options?: { timeoutMs?: number | undefined },
  ): Promise<EvalWorkflowRun>;
  /** Every run this app has started, oldest first, without waiting for any. */
  runs(): Promise<readonly EvalWorkflowRun[]>;
  /**
   * Wait for every run this app has started, oldest first, and read them all.
   *
   * **Not tidiness — a LEAK.** Two shipped templates hand-rolled this loop
   * verbatim, and `recap-workflow`'s doc says why: the scripted provider a case
   * installs is unpublished when that case finishes, so a body still mid-flight
   * makes its next request "against whatever the next case publishes — or
   * against the real provider, with a real key".
   *
   * The half that stays the CASE's is the release: what holds a run in flight is
   * a gate of the case's own, and nothing here can open one. So the shape is
   * `release(); await app.settleAll();`. A run started WHILE this drains is
   * drained too, and `timeoutMs` bounds each run rather than the set. See
   * `eval/_workflow-drain.ts` for the whole argument, including what
   * {@link EvalWorkflows.close} does when this is not called.
   */
  settleAll(options?: { timeoutMs?: number | undefined }): Promise<readonly EvalWorkflowRun[]>;
  /**
   * Unpublish the step slots and release the engine. Never rejects.
   *
   * **It does NOT wait for a run still in flight, and it says so out loud when
   * there is one** — a `process.emitWarning` naming the run and pointing at
   * {@link EvalWorkflows.settleAll}. Draining here could only deadlock and
   * abandoning silently is the leak; `eval/_workflow-drain.ts` argues all three
   * options.
   */
  close(): Promise<void>;
};

/**
 * Open a workflow app for evaluation.
 *
 * Synchronous, unlike `openEvalSession`: there is no session to start and no
 * greeting to wait out. It DOES install process-global step slots, so one app at
 * a time and `close()` is not optional — see `eval/workflow-engine.ts`.
 *
 * @throws if the agent declares no workflows. There is nothing to run, and the
 *   alternative is a client whose every call fails with the platform's
 *   "no workflow backend" message, which describes a deployment problem rather
 *   than this one.
 */
export function openEvalWorkflows(opts: EvalWorkflowsOptions): EvalWorkflows {
  const declared = opts.agent.workflows;
  if (!declared || Object.keys(declared).length === 0) {
    throw new Error(
      `Agent "${opts.agent.name}" declares no workflows, so there is nothing for an ` +
        "eval to run. Declare one with `workflow({ … })` and list it in " +
        "`agent({ workflows })`.",
    );
  }
  const logger = opts.logger ?? silentLogger;
  const env = opts.env ?? { ...evalWorkflowCredentials(opts.agent).env };
  const engine = createEvalWorkflowEngine({
    workflows: declared,
    env,
    ...omitUndefined({ stepFetch: opts.stepFetch, speech: opts.speech }),
  });
  // The REAL client. Only the engine under it is the eval's — see the module doc.
  const client = createWorkflowClient({
    workflows: declared,
    keys: createMemoryKeyStore(),
    wdk: engine.adapter,
    // A run cannot hand a webhook URL to anybody here anyway: `createWebhook()`
    // throws untransformed. Left unset so `publicWebhookUrl` says so by name.
    publicUrl: undefined,
    logger,
  });

  const timeoutFor = (override: number | undefined): number =>
    override ?? opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  async function read(runId: string, timeoutMs: number): Promise<EvalWorkflowRun> {
    const record = engine.record(runId);
    if (record === undefined) {
      throw new Error(
        `eval workflow app did not start run ${JSON.stringify(runId)} — ` +
          `it has started ${engine.records().length} run(s)`,
      );
    }
    // `p-timeout`, never a `Promise.race` with a timer (`guard-invariants`
    // rule 3): the losing branch's cleanup is exactly what gets re-derived
    // wrong, and a body that runs on after the deadline would keep narrating
    // into a record nobody reads.
    await pTimeout(record.settled, {
      milliseconds: timeoutMs,
      message: runTimeoutMessage(runId, timeoutMs, record),
    });
    return await snapshotOf(runId, record);
  }

  async function snapshotOf(runId: string, record: EvalRunRecord): Promise<EvalWorkflowRun> {
    // Through the CLIENT, so the run a case reads is the one a page would.
    const snapshot = await client.get(runId);
    if (snapshot === undefined) {
      throw new Error(`eval workflow client lost run ${JSON.stringify(runId)}`);
    }
    return {
      runId,
      workflow: snapshot.workflow,
      key: snapshot.key,
      status: snapshot.status,
      output: snapshot.status === "completed" ? snapshot.output : undefined,
      error: snapshot.status === "failed" ? snapshot.error : undefined,
      completed: snapshot.status === "completed",
      reported: record.reported,
      emitted: record.emitted,
      slept: record.slept,
      elapsedMs: record.elapsedMs,
      snapshot,
    };
  }

  /**
   * A def as the NAME the client resolves it by.
   *
   * The string overload rather than the def one, because the erased
   * implementation signature below holds an `AnyWorkflowDef` — whose `run` takes
   * `never`, which is exactly what makes it readable for an output type and
   * unusable as a `WorkflowDef`. Both overloads reach the same `resolve`, which
   * indexes a def by IDENTITY against this record, so the two are the same start.
   * An unknown def falls through to the client, whose message names the declared
   * set.
   */
  const nameOf = (workflow: AnyWorkflowDef): string =>
    Object.entries(declared).find(([, def]) => def === workflow)?.[0] ??
    workflow.description ??
    "(unnamed)";

  return {
    client,
    async run(
      workflow: AnyWorkflowDef | string,
      input?: unknown,
      options?: EvalRunOptions,
    ): Promise<EvalWorkflowRun> {
      const runId = await client.start(
        typeof workflow === "string" ? workflow : nameOf(workflow),
        input,
        options,
      );
      return await read(runId, timeoutFor(options?.timeoutMs));
    },
    settle(
      runId: string,
      _of?: AnyWorkflowDef | undefined,
      options?: { timeoutMs?: number | undefined },
    ): Promise<EvalWorkflowRun> {
      // `_of` is a TYPE argument only, exactly as `WorkflowClient.get`'s is: the
      // run's own record says which workflow it is.
      return read(runId, timeoutFor(options?.timeoutMs));
    },
    async runs(): Promise<readonly EvalWorkflowRun[]> {
      const runs: EvalWorkflowRun[] = [];
      for (const record of engine.records()) runs.push(await snapshotOf(record.runId, record));
      return runs;
    },
    settleAll(options?: { timeoutMs?: number | undefined }) {
      const timeoutMs = timeoutFor(options?.timeoutMs);
      return settleAllRuns(engine, (runId) => read(runId, timeoutMs));
    },
    async close(): Promise<void> {
      warnOnAbandonedRuns(engine);
      await releaseQuietly(engine);
    },
  };
}

/** What a timed-out run says it was doing, which is the only useful part. */
function runTimeoutMessage(runId: string, timeoutMs: number, record: EvalRunRecord): string {
  const last = record.reported.at(-1);
  return (
    `eval workflow run ${runId} did not settle within ${timeoutMs}ms ` +
    `(status ${record.status}, ${record.reported.length} progress line(s)` +
    `${last === undefined ? "" : `, last: ${JSON.stringify(last)}`})`
  );
}

/**
 * The output of a run that COMPLETED, or a throw naming what actually happened.
 *
 * Every workflow eval opened its assertions with the same four lines:
 *
 * ```ts no-check
 * // The error FIRST, so a failed run names its own reason instead of
 * // reporting "expected 'failed' to be 'completed'".
 * expect(run.error).toBeUndefined();
 * expect(run.status).toBe("completed");
 * const output = run.output;
 * if (output === undefined) expect.fail("a completed run must carry an output");
 * ```
 *
 * Eighteen `expect(run.error).toBeUndefined()` sites across six files, twelve of
 * them with that comment above them verbatim. **The comment is the finding**: the
 * ORDER of those two assertions is load-bearing and invisible, and it is the
 * whole reason the block exists — write the status check first and a failed run
 * reports `expected 'failed' to be 'completed'`, throwing away the message that
 * says which step broke and why. A rule whose only enforcement is a copied
 * comment is a missing function.
 *
 * It also narrows: {@link EvalWorkflowRun.output} is `R | undefined` because a
 * failed run has none, so every case needed the `if (output === undefined)`
 * guard to reach a field. This returns `R`.
 *
 * A reader with a throw rather than a matcher, like {@link toolResultIn} next
 * door — an eval brings its own runner, and `expect` in this module would make
 * `@alexkroman1/aai-runtime/eval` pull one.
 *
 * ```ts no-check
 * const output = completedOutput(await app.run(digest, { url }));
 * expect(output.headline).toMatch(/otter/i);
 * ```
 */
export function completedOutput<R>(run: EvalWorkflowRun<R>): R {
  if (run.status !== "completed") {
    // The reason first, for the reason above: a status alone says nothing about
    // which step broke, and `error` is where the body's own message is.
    throw new Error(
      `the run of "${run.workflow}" ${run.status} rather than completing: ` +
        (run.error ?? "no reason reported") +
        (run.reported.length === 0
          ? ""
          : ` (last progress line: ${JSON.stringify(run.reported.at(-1))})`),
    );
  }
  if (run.output === undefined) {
    throw new Error(
      `the run of "${run.workflow}" completed and carried no output — a body whose return value is what the page reads must return one`,
    );
  }
  return run.output;
}
