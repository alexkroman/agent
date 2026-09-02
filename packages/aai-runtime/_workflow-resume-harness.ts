// Copyright 2026 the AAI authors. MIT license.
/**
 * A GENERATED workflow body, plus a way to kill the worker at a chosen step
 * boundary and hand the run to a fresh delivery.
 *
 * This exists so `workflow-resume-equivalence.test.ts` can state the engine's
 * defining property — "resuming at any interruption point yields the same answer
 * as never being interrupted, and every step body runs exactly as often" — over
 * bodies nobody wrote by hand. The engine's other suites cover MECHANISMS (does
 * `appendStep` write a row?); this covers the thing those mechanisms exist for.
 *
 * ## Two crash models, and this file owns the FIRST
 *
 * A killed WORKER lives here; a rebuilt ENGINE lives in
 * `_workflow-rebuild-harness.ts`, which reuses this file's grammar and body
 * compiler and differs in what survives the interruption. The one below keeps
 * the process (and so the dispatcher's timers) and takes the delivery away; the
 * one next door keeps the journal and takes the TIMERS away, which is the
 * combination `createInProcessWorkflowEngine`'s boot sweep exists for and which
 * nothing here can reach — this driver builds the engine with
 * `dispatch: () => undefined` and hand-drives resumption, so the dispatcher is
 * not in its path at all. That blind spot cost a real defect; read that module's
 * doc before adding a scenario here.
 *
 * ## A crash is the CALLER's abort signal, and that is the faithful model
 *
 * `attemptLoop` calls `signal?.throwIfAborted()` at the top of every attempt —
 * before `claimAttempt`, so before an attempt is burned and before any body runs
 * — and `replayRun` re-throws an abort whose reason is the caller's rather than
 * recording it as a run failure. So aborting a caller-supplied signal at a step
 * boundary reproduces exactly what a killed worker leaves behind: the run still
 * `running`, the journal holding every step that settled, and `execute`
 * rejecting rather than writing a verdict. A redelivery is then just calling
 * `execute` again, which is what the platform's queue does.
 *
 * The one thing the simulation cannot do is stop work already in flight — a real
 * process death does. So a crash is followed by a macrotask DRAIN, which lets a
 * fan-out sibling that was already past the abort check finish and journal.
 * Without it, whether that sibling's row lands before or after the resuming
 * walk's `readSteps` is a scheduling coin-flip, and the oracle would report a
 * double execution that the engine did not cause.
 *
 * ## What the grammar deliberately does NOT generate
 *
 * Three shapes whose non-determinism belongs to the AUTHOR rather than to the
 * engine, and which would therefore produce false findings. A wait inside a
 * FAN-OUT: sleeps and hooks are keyed positionally (`sleep!N` by reach order),
 * so two branches racing to reach one key the same wait differently on two
 * walks — `ctx.step` is keyed by name, which is why steps may fan out and waits
 * may not. More than one step per `mapConcurrent` CALLBACK, which that
 * function's own doc refuses. And a body that CATCHES: legitimate, and covered
 * by `workflow-replay.test.ts`, but a generated one would swallow the abort a
 * simulated crash is made of and turn it into a run failure.
 *
 * ## An orchestrating step body is not COUNTED work
 *
 * `nested` and `nestedWait` wrap other steps in an outer `ctx.step`, whose entry
 * is not written until its children's are — so a crash inside one re-runs the
 * outer body on resume. That is honest at-least-once behaviour of nesting rather
 * than a defect, so the outer body performs no counted work: the exactly-once
 * claim is about LEAF step bodies, each of which has its own journal row.
 */

import { type WorkflowCtx, workflow } from "@alexkroman1/aai";
import { mapConcurrent } from "@alexkroman1/aai/step";
import { FatalError } from "@alexkroman1/aai/step-errors";
import { tick } from "./_test-utils.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { isTerminalStatus, type JournalStore, type RunStatus } from "./workflow-journal-types.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/** Long enough that no generated wait can elapse on its own. */
export const WAIT_MS = 60_000;

/** Deliveries one scenario may take before it is declared stuck. */
const MAX_DELIVERIES = 40;

/** A step that settles on its own. `flaky` throws once, then succeeds. */
export type Leaf = {
  readonly t: "step" | "flaky";
  readonly name: string;
  readonly value: number;
};

/** How a `ctx.waitFor` is answered. `timeout` never suspends: its window is already shut. */
export type HookMode = "signal" | "timedSignal" | "timeout";

/** One statement of a generated body, run in order. */
export type Node =
  | Leaf
  | { readonly t: "boom"; readonly name: string }
  | { readonly t: "loop"; readonly name: string; readonly count: number }
  | { readonly t: "sleep" }
  | { readonly t: "hook"; readonly token: string; readonly mode: HookMode }
  | { readonly t: "all"; readonly children: readonly Leaf[] }
  | { readonly t: "map"; readonly width: number; readonly children: readonly Leaf[] }
  | { readonly t: "nested"; readonly name: string; readonly children: readonly Leaf[] }
  | { readonly t: "nestedWait"; readonly name: string };

/** A whole generated body. */
export type Program = readonly Node[];

/** What one execution of a program did, as the oracle compares it. */
export type Scenario = {
  status: RunStatus | undefined;
  output: unknown;
  error: string | undefined;
  /** Journal keys, as a sorted list so two runs compare as sets. */
  keys: string[];
  /** Step NAME to how many times its body really ran. */
  counts: Record<string, number>;
  /** Counted step-body invocations, which is also the number of crash points. */
  total: number;
  /** Deliveries of the run message this scenario took. */
  deliveries: number;
  /** Suspends the driver had to advance past. */
  suspends: number;
  /** Hook waits this scenario answered with a signal. */
  signalled: number;
  /** True when the simulated crash really made a delivery fail. */
  crashed: boolean;
};

/** Knobs one scenario takes. */
export type ScenarioOptions = {
  /** Kill the worker at the end of this counted invocation (1-based). */
  crashAt?: number | undefined;
  /** Call `engine.cancel` at the end of this counted invocation (1-based). */
  cancelAt?: number | undefined;
  /** The engine's step gate width. 1 is what deadlocked on a nested step. */
  stepConcurrency?: number | undefined;
};

/** The bookkeeping a generated body reports through. */
export type Recorder = {
  /** Record an invocation of `name`'s body, and answer its global sequence number. */
  count(name: string): number;
  /** How many times `name`'s body has run so far, this invocation included. */
  runs(name: string): number;
  /** The end of an invocation, where a crash or a cancel is injected. */
  after(seq: number): Promise<void>;
};

/**
 * Give every step and token a name derived from its POSITION.
 *
 * Unique by construction, which is deliberate: a fan-out's branches reach their
 * steps in whatever order the loop resumes them, so shared names would make the
 * `name#occurrence` key depend on scheduling. `loop` is the one node that reuses
 * a name, and it is strictly sequential — which is the case occurrences exist for.
 */
export function label(program: Program): Program {
  let n = 0;
  const next = () => `s${n++}`;
  const leaves = (children: readonly Leaf[]): Leaf[] =>
    children.map((child) => ({ ...child, name: next() }));
  return program.map((node): Node => {
    switch (node.t) {
      case "step":
      case "flaky":
      case "boom":
      case "loop":
      case "nestedWait":
        return { ...node, name: next() };
      case "sleep":
        return node;
      case "hook":
        return { ...node, token: `tok${n++}` };
      case "all":
      case "map":
        return { ...node, children: leaves(node.children) };
      case "nested":
        return { ...node, name: next(), children: leaves(node.children) };
      default:
        return unreachable(node);
    }
  });
}

/**
 * A node the switches above do not handle.
 *
 * Every switch here is exhaustive over {@link Node}, which is what makes the
 * parameter `never` — so adding a node kind without teaching the walkers about
 * it is a compile error rather than a `default` that quietly does nothing.
 */
function unreachable(node: never): never {
  throw new Error(`unhandled generated node: ${JSON.stringify(node)}`);
}

/** Does this program reach a step that fails the run? */
export function fails(program: Program): boolean {
  return program.some((node) => node.t === "boom");
}

/** What the run's output must be, computed WITHOUT the engine. */
export function expectedOutput(program: Program): unknown[] {
  return program.map(nodeValue);
}

function nodeValue(node: Node): unknown {
  switch (node.t) {
    case "step":
    case "flaky":
      return node.value;
    case "boom":
      return undefined;
    case "loop":
      return Array.from({ length: node.count }, (_unused, i) => i);
    case "sleep":
    case "nestedWait":
      return null;
    case "hook":
      return node.mode === "timeout" ? undefined : { ok: node.token };
    case "all":
    case "map":
    case "nested":
      return node.children.map(nodeValue);
    default:
      return unreachable(node);
  }
}

/** Every hook token the program declares, in reach order. */
function tokensOf(program: Program): { token: string; mode: HookMode }[] {
  return program.flatMap((node) =>
    node.t === "hook" ? [{ token: node.token, mode: node.mode }] : [],
  );
}

/** One leaf step: the body, wrapped so its invocation is counted. */
function leafBody(leaf: Leaf, rec: Recorder): () => Promise<number> {
  return async () => {
    const seq = rec.count(leaf.name);
    try {
      if (leaf.t === "flaky" && rec.runs(leaf.name) === 1) {
        // A plain Error, so `retryDelay` is 0 and the retry costs no wall clock.
        throw new Error(`flaky ${leaf.name}`);
      }
      return leaf.value;
    } finally {
      await rec.after(seq);
    }
  };
}

function runLeaf(leaf: Leaf, ctx: WorkflowCtx, rec: Recorder): Promise<number> {
  return ctx.step(leaf.name, leafBody(leaf, rec));
}

async function runNode(node: Node, ctx: WorkflowCtx, rec: Recorder): Promise<unknown> {
  switch (node.t) {
    case "step":
    case "flaky":
      return runLeaf(node, ctx, rec);
    case "boom":
      return ctx.step(node.name, async () => {
        const seq = rec.count(node.name);
        try {
          throw new FatalError(`boom ${node.name}`);
        } finally {
          await rec.after(seq);
        }
      });
    case "loop": {
      const out: number[] = [];
      for (let i = 0; i < node.count; i++) {
        out.push(
          await ctx.step(node.name, async () => {
            const seq = rec.count(node.name);
            try {
              return i;
            } finally {
              await rec.after(seq);
            }
          }),
        );
      }
      return out;
    }
    case "sleep":
      await ctx.sleep(WAIT_MS);
      return null;
    case "hook":
      if (node.mode === "signal") return ctx.waitFor(node.token);
      // A deadline already in the past closes the window without suspending,
      // which is the other branch of `waitFor` and the one `closeHook` decides.
      return ctx.waitFor(node.token, { timeoutMs: node.mode === "timeout" ? -1 : WAIT_MS });
    case "all":
      return Promise.all(node.children.map((child) => runLeaf(child, ctx, rec)));
    case "map":
      return mapConcurrent(node.children, node.width, (child) => runLeaf(child, ctx, rec));
    case "nested":
      // The outer body does no counted work — see this module's doc.
      return ctx.step(node.name, async () => {
        const inner: unknown[] = [];
        for (const child of node.children) inner.push(await runLeaf(child, ctx, rec));
        return inner;
      });
    case "nestedWait":
      return ctx.step(node.name, async () => {
        await ctx.sleep(WAIT_MS);
        return null;
      });
    default:
      return unreachable(node);
  }
}

export async function runProgram(
  program: Program,
  ctx: WorkflowCtx,
  rec: Recorder,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const node of program) out.push(await runNode(node, ctx, rec));
  return out;
}

/** Discards. A generated body's abandonment warnings are not the finding. */
export const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * The world one run is driven through, mutated in place by {@link deliverOnce}.
 *
 * A bag rather than closure state, so the delivery loop is its own function —
 * `runScenario` was one body deciding four things at once and Biome measured it
 * over the complexity cap.
 */
type Drive = {
  engine: WorkflowEngine;
  journal: JournalStore;
  runId: string;
  /** Every hook the program declares, in reach order. */
  tokens: { token: string; mode: HookMode }[];
  /** Tokens a signal has already been delivered for. */
  answered: Set<string>;
  suspends: number;
  crashed: boolean;
};

/** What one delivery decided: the run is over, deliver again, or nothing can move it. */
type Advance = "done" | "again" | "stuck";

/**
 * Deliver the run once, then advance whatever it is waiting on.
 *
 * `live` is this delivery's own controller, which the recorder aborts to
 * simulate the worker dying — one per delivery, so a program that suspends ten
 * times before its crash point does not stack ten `AbortSignal.any` listeners on
 * one signal and trip the leak detector.
 */
async function deliverOnce(drive: Drive, live: AbortController): Promise<Advance> {
  let status: RunStatus | undefined;
  try {
    status = await drive.engine.execute(drive.runId, live.signal);
  } catch (err: unknown) {
    if (!live.signal.aborted) throw err;
    drive.crashed = true;
    // Let whatever was already past the abort check settle and journal, which a
    // real process death would have done by dying. See this module's doc.
    await tick();
    await tick();
    return "again";
  }
  if (status && isTerminalStatus(status)) return "done";
  drive.suspends++;
  if ((await drive.journal.wakeSleeps(drive.runId, undefined)) > 0) return "again";
  return answerHook(drive);
}

/** Signal the hook the body is parked on, if there is one left to answer. */
async function answerHook(drive: Drive): Promise<Advance> {
  const parked = drive.tokens.find(
    (hook) => hook.mode !== "timeout" && !drive.answered.has(hook.token),
  );
  if (!parked) return "stuck";
  drive.answered.add(parked.token);
  // A token the body has not registered yet answers `false` and costs nothing;
  // the next delivery finds it.
  if (!(await drive.engine.signal(parked.token, { ok: parked.token }))) {
    drive.answered.delete(parked.token);
  }
  return "again";
}

/**
 * Code-unit order, never `localeCompare`: with no explicit locale that answers
 * to the runtime's ICU default, so the same journal would sort two ways on two
 * machines and the oracle would report a divergence that is really a locale.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Run one generated program to a terminal status, optionally killing the worker
 * or cancelling the run at a chosen step boundary.
 */
export async function runScenario(
  program: Program,
  options: ScenarioOptions = {},
): Promise<Scenario> {
  const journal = createMemoryJournal();
  const counts = new Map<string, number>();
  let started = 0;
  let crashArmed = options.crashAt !== undefined;
  let cancelArmed = options.cancelAt !== undefined;
  let deliveries = 0;
  /** The controller of the delivery in flight — see {@link deliverOnce}. */
  let live: AbortController | undefined;

  const rec: Recorder = {
    count(name) {
      started++;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return started;
    },
    runs(name) {
      return counts.get(name) ?? 0;
    },
    async after(seq) {
      if (crashArmed && options.crashAt === seq) {
        crashArmed = false;
        live?.abort(new Error("the worker died here"));
      }
      if (cancelArmed && options.cancelAt === seq) {
        cancelArmed = false;
        await engine.cancel(runId);
      }
    },
  };

  const engine: WorkflowEngine = createWorkflowEngine({
    workflows: {
      generated: workflow({
        description: "generated",
        run: (_input, ctx) => runProgram(program, ctx, rec),
      }),
    },
    journal,
    streams: createMemoryStreams(),
    // Held back: `start` and `execute` are separate, and this driver is what
    // decides when a delivery happens.
    dispatch: () => undefined,
    newRunId: () => "wrun_generated",
    stepConcurrency: options.stepConcurrency ?? 4,
    logger: silent,
  });

  const runId = await engine.start("generated", [{}]);
  const drive: Drive = {
    engine,
    journal,
    runId,
    tokens: tokensOf(program),
    answered: new Set<string>(),
    suspends: 0,
    crashed: false,
  };

  for (deliveries = 1; deliveries <= MAX_DELIVERIES; deliveries++) {
    live = new AbortController();
    if ((await deliverOnce(drive, live)) !== "again") break;
  }

  const record = await journal.getRun(runId);
  return {
    status: record?.status,
    output: record?.output,
    error: record?.error?.message,
    keys: (await journal.readSteps(runId)).map((entry) => entry.key).sort(byCodeUnit),
    counts: Object.fromEntries(counts),
    total: started,
    deliveries,
    suspends: drive.suspends,
    signalled: drive.answered.size,
    crashed: drive.crashed,
  };
}
