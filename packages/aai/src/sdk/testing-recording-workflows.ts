// Copyright 2026 the AAI authors. MIT license.
/**
 * `createRecordingWorkflows` — a `ctx.workflows` that RECORDS every start and
 * runs nothing, with seedable runs for the reads.
 *
 * The client an eval of a workflow-starting agent wants: the question is which
 * run the agent reached for and with what input, and a body that really ran
 * would text a stranger or place a call. Downstream suites each built it on
 * `createStubWorkflows` — a `start` pushing onto a module-level log, a `find`
 * filtering a seeded list — and each needed two `as unknown as
 * WorkflowClient[...]` casts, because an object-literal method cannot satisfy
 * an overloaded signature. This is that client, with the casts made here.
 *
 * Framework-agnostic, so it serves a unit spec (`createToolContext({
 * workflows })`) and an eval (`describeEval(…, { workflows: () =>
 * createRecordingWorkflows({ workflows: agentDef.workflows }) })`, which reads
 * it back as `ctx.workflowClient`, typed) alike.
 *
 * @module testing-recording-workflows
 */

import { omitUndefined } from "./omit-undefined.ts";
import { createRunSnapshot } from "./testing-workflows.ts";
import type { AnyWorkflowDef } from "./workflow.ts";
import type { WorkflowClient } from "./workflow-client.ts";
import type { StartOptions } from "./workflow-options.ts";
import { isTerminal, type WorkflowRunSnapshot } from "./workflow-run.ts";
import { rejectingWorkflows } from "./workflow-unavailable.ts";

/**
 * One `start` the client recorded.
 *
 * @public
 */
export type RecordedStart = {
  /** The declared name — the key in `agent({ workflows })` — or the string passed. */
  readonly workflow: string;
  /** The def passed, when one was (`undefined` for a start by name). */
  readonly def: AnyWorkflowDef | undefined;
  /** The input, exactly as the tool passed it — not validated, since nothing runs. */
  readonly input: unknown;
  /** The start options (`key`, `label`, `notify`, …), when any were passed. */
  readonly options: StartOptions | undefined;
  /** The run id `start` resolved with. */
  readonly runId: string;
};

/**
 * What {@link createRecordingWorkflows} takes.
 *
 * @public
 */
export type RecordingWorkflowsOptions = {
  /**
   * The agent's declared workflows — pass `agentDef.workflows` — so a start
   * by DEF is recorded under its declared name, and `listing()` reports them.
   * A def not in it is refused, as the real client refuses it. Without it, a
   * def is recorded under its `description` and matched by identity.
   */
  workflows?: Readonly<Record<string, AnyWorkflowDef>> | undefined;
  /**
   * Runs the reads answer from before anything starts — a reminder already
   * pending, a job that failed. Build them with `createRunSnapshot`; more can
   * be added later with `seed`.
   */
  runs?: readonly WorkflowRunSnapshot[] | undefined;
  /** Prefix of the minted run ids, numbered from 1. Defaults to `"wrun_rec_"`. */
  runIdPrefix?: string | undefined;
};

/**
 * A `WorkflowClient` that records, plus its log.
 *
 * `start` records and resolves a fresh run id, and the run it "started" is
 * visible to `get`/`find`/`recent` as `running` — so a tool that checks for a
 * pending run before starting a second one sees its own first start. `cancel`
 * marks a known, unfinished run `cancelled` and resolves `true` (else
 * `false`); `wakeUp` resolves `0`; `lastLine` resolves `undefined`. The
 * progress-channel reads (`stream`, `streamTail`, `signal`,
 * `publicWebhookUrl`) REJECT, as `createStubWorkflows`' do — spread over it to
 * answer one.
 *
 * @public
 */
export type RecordingWorkflows = WorkflowClient & {
  /** Every start, in order. */
  readonly starts: RecordedStart[];
  /**
   * The starts of one workflow — by declared name or by def — or all of them.
   */
  started(workflow?: string | AnyWorkflowDef): RecordedStart[];
  /** Every run id `cancel` was called with, in order, whatever it resolved. */
  readonly cancelled: string[];
  /** Add runs for the reads to answer from, e.g. inside a case before `say()`. */
  seed(...runs: WorkflowRunSnapshot[]): void;
};

/**
 * Build a {@link RecordingWorkflows}.
 *
 * @example
 * ```ts
 * import { createRecordingWorkflows, createRunSnapshot } from "@alexkroman1/aai/testing";
 *
 * const workflows = createRecordingWorkflows({
 *   runs: [createRunSnapshot({ workflow: "remind", key: "kitchen", runId: "wrun_pending" })],
 * });
 * await workflows.start("remind", { text: "flip the laundry" }, { key: "kitchen" });
 * console.log(workflows.started("remind").length); // 1
 * console.log((await workflows.find("remind", "kitchen")).length); // 2
 * ```
 *
 * @public
 */
export function createRecordingWorkflows(
  options: RecordingWorkflowsOptions = {},
): RecordingWorkflows {
  const declared = options.workflows;
  const prefix = options.runIdPrefix ?? "wrun_rec_";
  const starts: RecordedStart[] = [];
  const cancelled: string[] = [];
  const runs: WorkflowRunSnapshot[] = [...(options.runs ?? [])];

  const nameOf = (workflow: string | AnyWorkflowDef): string => {
    if (typeof workflow === "string") return workflow;
    if (declared === undefined) return workflow.description ?? "(unnamed)";
    const found = Object.entries(declared).find(([, def]) => def === workflow)?.[0];
    if (found !== undefined) return found;
    throw new Error(
      `createRecordingWorkflows: a workflow def not in \`workflows\` (declared: ${
        Object.keys(declared).join(", ") || "none"
      }) — the real client refuses it too. Wire it into agent({ workflows }).`,
    );
  };
  // Newest first, as the real `find` and `recent` answer.
  const newestFirst = (filter: (run: WorkflowRunSnapshot) => boolean) =>
    runs.filter(filter).reverse();

  const recording: Partial<WorkflowClient> = {
    async start(workflow: string | AnyWorkflowDef, input?: unknown, startOptions?: StartOptions) {
      const name = nameOf(workflow);
      const runId = `${prefix}${starts.length + 1}`;
      starts.push({
        workflow: name,
        def: typeof workflow === "string" ? undefined : workflow,
        input,
        options: startOptions,
        runId,
      });
      runs.push(
        createRunSnapshot({
          runId,
          workflow: name,
          createdAt: Date.now(),
          ...omitUndefined({ key: startOptions?.key }),
        }),
      );
      return runId;
    },
    // Typed by the name-only arm: a def-typed caller's `R` is a promise about
    // the run's output that a recorder, which runs nothing, cannot keep either way.
    get: (async (runId: string) =>
      runs.find((run) => run.runId === runId)) as WorkflowClient["get"],
    find: (async (workflow: string | AnyWorkflowDef, key: string) => {
      const name = nameOf(workflow);
      return newestFirst((run) => run.workflow === name && run.key === key);
    }) as WorkflowClient["find"],
    recent: (async (workflow: string | AnyWorkflowDef) => {
      const name = nameOf(workflow);
      return newestFirst((run) => run.workflow === name);
    }) as WorkflowClient["recent"],
    async cancel(runId: string) {
      cancelled.push(runId);
      const at = runs.findIndex((run) => run.runId === runId);
      const run = runs[at];
      if (run === undefined || isTerminal(run)) return false;
      runs[at] = createRunSnapshot({ ...run, status: "cancelled" });
      return true;
    },
    async wakeUp() {
      return 0;
    },
    async lastLine() {
      // `undefined`: "the run has written nothing yet" — nothing here runs.
    },
    listing() {
      return Object.keys(declared ?? {}).map((name) => ({ name }));
    },
  };

  return {
    ...rejectingWorkflows(
      "This ctx.workflows method is not recorded by createRecordingWorkflows — spread the " +
        "client and supply it",
    ),
    ...recording,
    starts,
    cancelled,
    started(workflow) {
      if (workflow === undefined) return [...starts];
      if (typeof workflow === "string") return starts.filter((s) => s.workflow === workflow);
      return starts.filter((s) => s.def === workflow);
    },
    seed(...more) {
      runs.push(...more);
    },
  };
}
