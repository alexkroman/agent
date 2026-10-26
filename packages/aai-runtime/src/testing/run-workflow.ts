// Copyright 2026 the AAI authors. MIT license.
/**
 * Run a workflow body against a REAL durable engine, from a spec.
 *
 * ## The gap this closes, and why it could not be closed before
 *
 * A workflow is three things — a declaration, a set of steps, and a body — and
 * before this only the first two were testable. `@alexkroman1/aai/testing`'s
 * `createWorkflowContext` drives a body over a recording context and says so
 * plainly: *"It is not a durability test, and a spec built on it must not claim
 * to be one. There is no journal, so nothing is memoized and nothing replays."*
 * `@alexkroman1/aai-runtime/eval`'s workflow engine says the same from the other
 * end. So the eight shipped templates with a `workflows/` directory have specs
 * for their steps and their declarations, and none at all for the property those
 * templates exist to demonstrate: that a run survives a suspension, a signal and
 * a dead worker.
 *
 * **The constraint those two modules cite is no longer true.** Both were written
 * against the Workflow DevKit, where a body was only durable after a
 * compile-time transform: *"the transform is what turns each `use step`
 * declaration into a dispatcher, and the queue behind that dispatcher is what
 * journals a result, replays a resume and retries a failure. An eval imports the
 * body through a test runner with no bundler in the path."* Since the DevKit was
 * replaced, the engine runs a run off the agent's own `workflows` declaration
 * against a `JournalStore`, in process, with no bundler anywhere — which is
 * exactly what a vitest file can construct. `createInProcessWorkflowEngine` is
 * the same composition root `aai dev` and a self-hosted server use.
 *
 * So this is not a fake of the engine. It is the engine, over the memory journal
 * that is its own reference implementation of the contract, with the driver
 * supplying what a deployment's queue supplies.
 *
 * ## The dispatcher is INJECTED, and that is the one substitution
 *
 * `createInProcessWorkflowEngine` defaults to delivering on a `setTimeout`, so a
 * `ctx.sleep(SIX_HOURS)` really arms a six-hour timer. A spec cannot wait one
 * and must not fake the clock to skip it — a fake clock reaches every timer in
 * the process, and the wait it would be skipping is a JOURNALED deadline rather
 * than a timer in the first place. So the driver passes its own `dispatch`,
 * which is a supported and load-bearing path rather than a testing hook: a
 * deployed guest passes `createPlatformDispatch` for the same reason, its timers
 * dying with a sandbox that self-exits.
 *
 * Two consequences, both stated where they matter. A scheduled delivery is
 * RECORDED (as {@link WorkflowTestRun.wakeAt}) instead of taken, so a spec
 * asserts what the body asked for and ends the wait with
 * {@link WorkflowTestHandle.advanceSleep}. And the boot sweep is off — it is
 * skipped whenever a dispatcher is injected, deliberately, because *"a deployed
 * guest's schedule is a delayed message in the platform's queue, which has its
 * own reconcile"* — so {@link WorkflowTestHandle.restart} re-delivers
 * explicitly, modelling the queue rather than the sweep.
 *
 * ## What it still does NOT cover, stated so a spec cannot over-claim
 *
 * - **A backend other than memory.** The three `JournalStore` implementations
 *   are held against each other by `workflow/journal/conformance.ts` and its Postgres
 *   scenario arm, which is a different question from this one.
 * - **Two deliveries of one run OVERLAPPING.** The driver delivers one at a
 *   time; `workflow/concurrent-delivery.test.ts` is the property that runs them
 *   into each other, and `workflow-interleavings/` freezes the ones worth
 *   keeping.
 * - **A body's own non-determinism.** A step that reads `Date.now()` directly
 *   will differ between the first walk and the resume, which is
 *   `guard-invariants` rule 30 and what `ctx.now`/`ctx.random`/`ctx.uuid` are
 *   for. This surfaces it as a difference rather than diagnosing it.
 *
 * @module
 */

import type { ToolInputSchema, WorkflowDef } from "@alexkroman1/aai";
import { workflowSignalToken } from "@alexkroman1/aai/host-internal";
import { parseSchemaInput } from "@alexkroman1/aai/testing";
import {
  DEFAULT_SIGNAL_HOLD_MS,
  type WorkflowAppLike,
  type WorkflowDefOf,
  type WorkflowNameOf,
  type WorkflowOutputOf,
  workflowNameOf,
} from "@alexkroman1/aai/workflow-api";
import { type Logger, silentLogger } from "../logger.ts";
import { unknownWorkflowMessage } from "../workflow/client.ts";
import { takeHeldSignal } from "../workflow/held-signals.ts";
import {
  createInProcessWorkflowEngine,
  type InProcessWorkflowEngine,
} from "../workflow/in-process.ts";
import { createMemoryJournal } from "../workflow/journal/backends/memory.ts";
import { journalStoreOf, workflowJournal } from "../workflow/journal/handle.ts";
import { isTerminalStatus, type JournalStore, type SleepEntry } from "../workflow/journal/types.ts";
import { type DeterminismKind, isDeterminismKey } from "../workflow/replay/determinism.ts";
import { RUN_KEY_STEP } from "../workflow/replay/run-key.ts";
import type {
  RunWorkflowOptions,
  WorkflowTestHandle,
  WorkflowTestRead,
  WorkflowTestRun,
  WorkflowTestStep,
  WorkflowTestWait,
} from "./run-workflow-types.ts";

/**
 * How many deliveries one run may take before the driver gives up.
 *
 * Generous — a template's longest body suspends twice — and low enough that a
 * body woken in a loop fails in milliseconds with a message naming the bound
 * rather than hanging until the runner's own timeout, which reports the runner.
 *
 * @public
 */
export const DEFAULT_MAX_DELIVERIES = 50;

/** One queued delivery, as the injected dispatcher receives it. */
type Queued = { runId: string; at: number | undefined };

/** The key a run is started with when the spec names none — see `RunWorkflowOptions.key`. */
const DEFAULT_RUN_KEY = "test";

/**
 * Start `def` with `input` and drive it until it finishes or parks.
 *
 * Resolves a handle carrying the run's status, output and journaled steps, with
 * four methods for the things only a durable run can do — end a wait, answer a
 * hook, survive a restart, and shut down.
 *
 * The input is validated against `def.input` when the declaration has one, which
 * is what `ctx.workflows.start` does on every real path: a body is written
 * against a validated input, so handing it an unvalidated one tests a call that
 * cannot happen.
 *
 * **Two forms.** Handed a DEF, the run is named by the name the def was
 * declared under (`workflowNameOf`, recorded when the agent declaring it was
 * lowered — a `virtual:aai/agent` import), else `"workflow"`; there is no
 * `name` option. Handed the AGENT and a workflow's name —
 * `runWorkflow(agentDef, "digest", input)`, with `agentDef` from
 * `virtual:aai/agent` — the def is the one the agent declares (or the build
 * discovered in `workflows/`) under that name, and the run carries that name,
 * so a body that reads `ctx.workflow`, starts a sibling by name or is found by
 * `ctx.workflows.find` sees what a deployment would. An unknown name throws,
 * listing the ones the agent has. A spec that asserts on the name (a signal
 * token, `ctx.workflow`) uses the agent form, which is the one a deployment
 * runs.
 *
 * @example
 * ```ts
 * import { workflow } from "@alexkroman1/aai";
 * import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
 *
 * const digest = workflow({
 *   description: "Summarize a link, then file it once it has settled.",
 *   run: async (input, ctx) => {
 *     const text = await ctx.step("read", () => `the page at ${String(input.url)}`);
 *     await ctx.sleep("settle", 10_000);
 *     return { text, filedAt: await ctx.step("file", () => "ok") };
 *   },
 * });
 *
 * const run = await runWorkflow(digest, { url: "https://example.com/a" });
 *
 * // It slept rather than blocking, and said for how long.
 * console.log(run.status, run.wakeAt);
 *
 * // And it resumes off the journal without re-running what it already did.
 * await run.advanceSleep();
 * console.log(run.status, run.output, run.deliveries);
 * ```
 *
 * @example The agent form: the name is checked against what the agent declares
 * ```ts
 * import { agent, workflow } from "@alexkroman1/aai";
 * import { runWorkflow } from "@alexkroman1/aai-runtime/testing";
 * import { z } from "zod";
 *
 * const digest = workflow({
 *   input: z.object({ url: z.string() }),
 *   run: async ({ url }, ctx) => ({ text: await ctx.step("read", () => `the page at ${url}`) }),
 * });
 * const agentDef = agent({ name: "Digest", workflows: { digest } });
 *
 * const run = await runWorkflow(agentDef, "digest", { url: "https://example.com/a" });
 * ```
 *
 * @typeParam R - What the body returns, taken from the declaration.
 *
 * @public
 */
export async function runWorkflow<P extends ToolInputSchema, R>(
  def: WorkflowDef<P, R>,
  input: Record<string, unknown>,
  options?: RunWorkflowOptions,
): Promise<WorkflowTestHandle<R>>;
export async function runWorkflow<App extends WorkflowAppLike, Name extends WorkflowNameOf<App>>(
  agent: App,
  name: Name,
  input: Record<string, unknown>,
  options?: RunWorkflowOptions,
): Promise<WorkflowTestHandle<WorkflowOutputOf<WorkflowDefOf<App, Name>>>>;
export async function runWorkflow(
  first: WorkflowDef<ToolInputSchema, unknown> | WorkflowAppLike,
  second: string | Record<string, unknown>,
  third?: Record<string, unknown> | RunWorkflowOptions,
  fourth?: RunWorkflowOptions,
): Promise<WorkflowTestHandle<unknown>> {
  if (typeof second === "string") {
    const agent = first as WorkflowAppLike;
    const def = agent.workflows?.[second];
    if (def === undefined) {
      // The client's own sentence (declared set, nearest name), so a spec and
      // a tool are refused in the same words.
      throw new Error(
        `runWorkflow: ${unknownWorkflowMessage(second, Object.keys(agent.workflows ?? {}))} ` +
          "Check the name, or register the def in agent({ workflows }) or as workflows/<name>.ts.",
      );
    }
    // The declared def is a `WorkflowDef` (`AnyWorkflowDef` is the reading's
    // contravariant view of it); the agent's key wins over any recorded one.
    return runDef(
      def as WorkflowDef<ToolInputSchema, unknown>,
      second,
      (third as Record<string, unknown> | undefined) ?? {},
      fourth ?? {},
    );
  }
  const def = first as WorkflowDef<ToolInputSchema, unknown>;
  return runDef(
    def,
    workflowNameOf(def) ?? "workflow",
    second,
    (third as RunWorkflowOptions | undefined) ?? {},
  );
}

/** Both forms, once the name is settled — see {@link runWorkflow}. */
async function runDef<P extends ToolInputSchema, R>(
  def: WorkflowDef<P, R>,
  name: string,
  input: Record<string, unknown>,
  options: RunWorkflowOptions,
): Promise<WorkflowTestHandle<R>> {
  const key = options.key ?? DEFAULT_RUN_KEY;
  const logger = options.logger ?? silentLogger;
  const maxDeliveries = options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES;
  const validated = def.input
    ? await parseSchemaInput<Record<string, unknown>>(def.input, input, `workflow ${name}`)
    : input;

  const queue: Queued[] = [];
  const dispatch = (runId: string, at?: number) => {
    queue.push({ runId, at });
  };

  // The crash is armed on the JOURNAL rather than on the body: a worker dies
  // where it happens to be, and the one place every step passes through on its
  // way to running is `claimAttempt` — which is also where the charge that
  // records the abandoned attempt is made. See `RunWorkflowOptions.crashAt`.
  //
  // A controller PER DELIVERY, never one for the run: a single one stays
  // aborted after it fires, so every later delivery — the restart included —
  // would be killed before it read the journal, and the run could not be shown
  // to resume at all.
  let crash: AbortController | undefined;
  let armed = options.crashAt;
  // The deadline KEYS `expireWaits` has closed — see its doc for why nothing
  // public can end a `waitFor` window and why this answers the READ rather
  // than rewriting the record. Each call adds what was outstanding at the
  // call, so a window the body opens during the delivery it triggers is not
  // closed before it was ever open; and a key stays here for the rest of the
  // run, because the window DID close (`closeHook` ran) and every later walk
  // re-reads its deadline on the way past — answered as still open, the run
  // would park on a window it already took the timeout branch of.
  const expiring = new Set<string>();
  const store = journalStoreOf(options.journal) ?? createMemoryJournal();
  const journal: JournalStore = {
    ...store,
    claimAttempt: async (runId, key, holder, leaseMs) => {
      const attempt = await store.claimAttempt(runId, key, holder, leaseMs);
      if (armed !== undefined && key.startsWith(`${armed}#`)) {
        armed = undefined;
        crash?.abort(new Error(`runWorkflow: the worker died at ${key}`));
      }
      return attempt;
    },
    claimSleep: async (runId, key, wakeAt, correlationId, kind) => {
      const record = await store.claimSleep(runId, key, wakeAt, correlationId, kind);
      // Only a hook's DEADLINE, never an ordinary `ctx.sleep`: those are
      // `advanceSleep`'s, through the engine's own `wakeUp`, and folding the two
      // together is the exact mistake `SleepRecord.kind` exists to prevent.
      if (record.kind !== "hookTimeout" || !expiring.has(key)) return record;
      return { ...record, woken: true };
    },
  };
  const { resumableRuns } = store;
  if (resumableRuns) journal.resumableRuns = (limit) => resumableRuns.call(store, limit);

  // A world handed in is one another run may still be LIVE in, and two live runs
  // of one workflow under one key share their signal tokens — see
  // `refuseLiveTwin` for what that did.
  if (options.journal !== undefined) await refuseLiveTwin(store, name, key);

  const state = {
    engine: build(name, def, journal, logger, dispatch),
    status: "pending",
    output: undefined,
    error: undefined,
    steps: [] as readonly WorkflowTestStep[],
    reads: [] as readonly WorkflowTestRead[],
    waits: [] as readonly WorkflowTestWait[],
    resumable: false,
    wakeAt: undefined,
    deliveries: 0,
    crashed: false,
    signalled: false,
  } as Mutable<R>;

  const runId = await state.engine.start(name, [validated], { key });

  /**
   * Tokens this handle asked the engine to HOLD a payload for.
   *
   * A hold lives in process memory keyed by the token alone
   * (`workflow/held-signals.ts`), so one this run never takes would be taken
   * by the next spec's run under the same name, key and label. Dropped the
   * moment the run is terminal (nothing of this run can take it any more) and
   * on `close`.
   */
  const held = new Set<string>();
  const dropHolds = (): void => {
    for (const token of held) takeHeldSignal(token);
    held.clear();
  };

  const handle: WorkflowTestHandle<R> = {
    runId,
    key,
    // The UNWRAPPED store: a second run handed this must not inherit this
    // run's crash arming or its window expiry.
    journal: workflowJournal(store),
    get status() {
      return state.status;
    },
    get output() {
      return state.output;
    },
    get error() {
      return state.error;
    },
    get steps() {
      return state.steps;
    },
    get reads() {
      return state.reads;
    },
    get waits() {
      return state.waits;
    },
    get resumable() {
      return state.resumable;
    },
    get wakeAt() {
      return state.wakeAt;
    },
    get deliveries() {
      return state.deliveries;
    },
    get crashed() {
      return state.crashed;
    },
    get signalled() {
      return state.signalled;
    },
    async advanceSleep(correlationIds) {
      await state.engine.wakeUp(runId, correlationIds ? [...correlationIds] : undefined);
      await drain();
      return handle;
    },
    async signal(token, payload, options) {
      // `{}` for an absent payload and a hold only when asked — exactly what
      // `ctx.workflows.signal` sends (`workflow/client.ts`), so a spec written
      // against this handle reads the branch a tool's call would reach.
      const holdMs = options?.holdMs ?? 0;
      if (holdMs > 0) held.add(token);
      state.signalled = await state.engine.signal(token, payload ?? {}, { holdMs });
      await drain();
      return handle;
    },
    signalRun(label, payload, options) {
      // The token the body derived (`sdk/workflow-signals.ts`), from the same
      // three parts, so neither side spells it. Held by default, as
      // `ctx.workflows.signalRun` holds: a signal sent while the body is still
      // ahead of its wait (parked on a `ctx.sleep`, say) is kept for the wait
      // rather than dropped with `signalled: false` — and, as there, only for a
      // run still GOING: a finished run has no wait left to take it, and the
      // payload would sit for the next run under the key.
      const live = !isTerminalStatus(state.status);
      return handle.signal(workflowSignalToken(name, key, label), payload, {
        holdMs: live ? (options?.holdMs ?? DEFAULT_SIGNAL_HOLD_MS) : 0,
      });
    },
    async expireWaits() {
      // The windows open NOW — and only those: see the set's own comment.
      for (const wait of await store.readSleeps(runId)) {
        if (wait.kind === "hookTimeout" && !wait.woken) expiring.add(wait.key);
      }
      // A delivery of its own, because a parked run has nothing in flight: the
      // window closes on the walk that re-reads it.
      queue.push({ runId, at: undefined });
      await drain();
      return handle;
    },
    async restart() {
      state.engine.stop();
      state.engine = build(name, def, journal, logger, dispatch);
      queue.push({ runId, at: undefined });
      await drain();
      return handle;
    },
    async close() {
      state.engine.stop();
      dropHolds();
    },
  };

  /**
   * Take deliveries until the queue is empty.
   *
   * A queued entry carrying an `at` is a SCHEDULE, not a delivery: the body
   * suspended on a journaled deadline, and taking it now would deliver a run
   * that is going to re-suspend on the same wake time. It is recorded instead,
   * which is what `advanceSleep` then ends.
   */
  async function drain(): Promise<void> {
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.at !== undefined) {
        state.wakeAt = next.at;
        continue;
      }
      if (state.deliveries >= maxDeliveries) {
        throw new Error(
          `runWorkflow: run ${runId} took ${maxDeliveries} deliveries without settling. ` +
            "A body woken in a loop is the usual cause; raise maxDeliveries if the run " +
            "really needs more.",
        );
      }
      state.deliveries += 1;
      state.wakeAt = undefined;
      await deliver(next.runId);
    }
    await refresh();
  }

  /** One delivery, with a crash reported rather than thrown. */
  async function deliver(target: string): Promise<void> {
    const controller = new AbortController();
    crash = controller;
    try {
      await state.engine.execute(target, controller.signal);
    } catch (err: unknown) {
      // Only OUR abort. Anything else is a real failure of the journal or of
      // the engine, and swallowing it would report a broken store as a parked
      // run — the exact shape of failure this whole surface is meant to expose.
      if (err !== controller.signal.reason) throw err;
      state.crashed = true;
    } finally {
      crash = undefined;
    }
  }

  /** Read the run back off the journal. */
  async function refresh(): Promise<void> {
    const record = await journal.getRun(runId);
    state.status = record?.status ?? "pending";
    state.output = record?.status === "completed" ? (record.output as R) : undefined;
    state.error = record?.error?.message;
    const journaled = await journal.readSteps(runId);
    state.steps = journaled
      // Neither a determinism read nor the run's own key entry is a STEP the
      // body named (`workflow/replay/run-key.ts`).
      .filter((entry) => !isDeterminismKey(entry.key) && entry.key !== RUN_KEY_STEP)
      .map(toStep)
      .sort(byCallSite);
    state.reads = journaled
      .filter((entry) => isDeterminismKey(entry.key))
      .map(toRead)
      .sort(byCallSite);
    if (record && isTerminalStatus(record.status)) {
      state.wakeAt = undefined;
      dropHolds();
    }
    state.waits = (await store.readSleeps(runId)).map(toWait).sort(byKey);
    const owed = (await store.resumableRuns?.(RESUMABLE_SCAN_LIMIT)) ?? [];
    state.resumable = owed.some((one) => one.runId === runId);
  }

  await drain();
  return handle;
}

/**
 * Refuse a second run of `name` under `key` while a first is still live in the
 * same journal.
 *
 * A signal token is derived from (workflow, key, label) — `workflowSignalToken`
 * — so two live runs sharing all three HOLD THE SAME TOKENS: the second's body
 * failed at its first `waitForSignal` ("token … is already held by run A"),
 * and its `signalRun("first")` then reported `signalled: true` having woken run
 * A, whose own later signal found nothing to answer. Both runs start under
 * `DEFAULT_RUN_KEY` unless a spec says otherwise, which made the collision the
 * default outcome of the documented "pass `journal` to start two runs in the
 * same world". The engine's own message names the token; this one names the
 * key and the fix, at the call that started the twin.
 *
 * Only a LIVE twin: a settled run holds no tokens, so sharing a world with one
 * (the case the shared-journal spec exercises) is untouched.
 */
async function refuseLiveTwin(store: JournalStore, name: string, key: string): Promise<void> {
  for (const record of await store.listRuns(name, RESUMABLE_SCAN_LIMIT)) {
    if (isTerminalStatus(record.status)) continue;
    const entry = await store.readStep(record.runId, RUN_KEY_STEP);
    if (entry?.output !== key) continue;
    throw new Error(
      `runWorkflow: run ${record.runId} of "${name}" is still live in this journal under the ` +
        `key ${JSON.stringify(key)}, so a second run under the same key would share its signal ` +
        "tokens — a signalRun() meant for one reaches the other. Give the second run its own " +
        `key — runWorkflow(…, { journal, key: "<another>" }) — or let the first settle first.`,
    );
  }
}

/** The mutable half of a handle — see the getters above. */
type Mutable<R> = {
  engine: InProcessWorkflowEngine;
} & { -readonly [K in keyof WorkflowTestRun<R> as Exclude<K, "runId">]: WorkflowTestRun<R>[K] } & {
  signalled: boolean;
};

/** A fresh engine over the same journal — what a restart really is. */
function build<P extends ToolInputSchema, R>(
  name: string,
  def: WorkflowDef<P, R>,
  journal: JournalStore,
  logger: Logger,
  dispatch: (runId: string, at?: number) => void,
): InProcessWorkflowEngine {
  return createInProcessWorkflowEngine({ workflows: { [name]: def }, journal, logger, dispatch });
}

/**
 * By call SITE: the name ascending, then the occurrence NUMERICALLY.
 *
 * Both halves come out of the KEY, so one comparator serves steps and
 * determinism reads alike — `now!0` and `summarize#0` are the same shape either
 * side of a different separator.
 *
 * The occurrence is compared as a number rather than as text, which a sort of
 * the whole key gets wrong: `poll#10` sorts before `poll#2` as a string, so a
 * body that polled eleven times would list its rounds out of order — and the
 * order is the only reason this is sorted at all. See
 * {@link WorkflowTestRun.steps} for why the journal's own order is not used.
 */
function byCallSite(a: { key: string }, b: { key: string }): number {
  const left = splitKey(a.key);
  const right = splitKey(b.key);
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  return left.occurrence - right.occurrence;
}

/**
 * A journal key as its two parts.
 *
 * `lastIndexOf` on either separator rather than a regex, because a step NAME may
 * legally contain a `#` and the LAST one is always the engine's. A key with
 * neither is impossible from either writer; it answers occurrence `0` rather
 * than `NaN`, so a malformed one sorts first instead of making every comparison
 * against it undefined.
 */
function splitKey(key: string): { name: string; occurrence: number } {
  const at = Math.max(key.lastIndexOf("#"), key.lastIndexOf("!"));
  if (at < 0) return { name: key, occurrence: 0 };
  const occurrence = Number(key.slice(at + 1));
  return { name: key.slice(0, at), occurrence: Number.isFinite(occurrence) ? occurrence : 0 };
}

/** A determinism read, projected — see {@link WorkflowTestRead}. */
function toRead(entry: { key: string; name: string; output?: unknown }): WorkflowTestRead {
  return {
    key: entry.key,
    // The engine writes the KIND as the entry's name, so nothing here re-parses
    // the key to recover it.
    kind: entry.name as DeterminismKind,
    value: entry.output,
  };
}

/**
 * How far `refresh` reads the boot sweep's query to answer
 * {@link WorkflowTestRun.resumable}. A spec's journal holds a handful of runs.
 */
const RESUMABLE_SCAN_LIMIT = 1000;

/** A journaled wait, projected — see {@link WorkflowTestWait}. */
function toWait(entry: SleepEntry): WorkflowTestWait {
  return {
    key: entry.key,
    kind: entry.kind,
    wakeAt: entry.wakeAt,
    woken: entry.woken,
    correlationId: entry.correlationId,
  };
}

/** By journal key — a wait list's order must not depend on the backend's. */
function byKey(a: { key: string }, b: { key: string }): number {
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

/** A journal entry, projected — see {@link WorkflowTestStep} for why. */
function toStep(entry: {
  key: string;
  name: string;
  status: "ok" | "failed";
  output?: unknown;
  error?: { message: string } | undefined;
  attempts: number;
}): WorkflowTestStep {
  return {
    key: entry.key,
    name: entry.name,
    status: entry.status,
    output: entry.output,
    error: entry.error?.message,
    attempts: entry.attempts,
  };
}
