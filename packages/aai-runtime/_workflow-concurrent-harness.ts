// Copyright 2026 the AAI authors. MIT license.
/**
 * Two or three deliveries of ONE run, overlapping inside the journal, with
 * fast-check deciding the interleaving.
 *
 * `workflow-engine.ts` states the safety claim this exists to test:
 *
 * > A delivery is AT-LEAST-ONCE, and `execute` is written for that. Two
 * > deliveries of one run may overlap. What keeps that safe is not a lock — a
 * > lock is a thing to lose — but the journal.
 *
 * One of four modules behind `workflow-concurrent-delivery.test.ts`, and the
 * DRIVER: `_workflow-schedule-harness.ts` is the wire every journal call goes
 * through, `_workflow-laws-harness.ts` is what the result is read back as, and
 * `_workflow-reach-harness.ts` counts what the interleaving reached.
 * The bodies are `_workflow-resume-program.ts`, the same grammar the two
 * sequential crash models are written against — this is its third consumer, and
 * nothing here re-implements any of it.
 *
 * ## What was backing that claim, and what this adds
 *
 * One hand-written pair (`Promise.all([replay(j, b), replay(j, b)])` in
 * `workflow-replay.test.ts`), over one body with one step — and the repo already
 * says elsewhere that a `Promise.all` of two calls is not interleaving
 * (`sdk/session-slot.test.ts`: *"Real interleaving, which
 * `Promise.all([execute(…), execute(…)])` cannot"*). Both existing CRASH models
 * are sequential by construction: `_workflow-resume-harness.ts` takes the
 * delivery away at a step boundary, and `_workflow-rebuild-harness.ts` tears the
 * engine down BEFORE the replacement exists, on purpose — *"two live engines
 * over one journal would let the old one's timer answer for the new one's sweep
 * and prove nothing"*. So nothing generated ever had two walks of one run in the
 * journal at the same moment.
 *
 * ## One engine, because the step gate is per ENGINE
 *
 * `createStepGate` is one gate for the whole engine deliberately — *"what it
 * protects is process memory, and a deployed guest serves every run of its
 * slug"* — so a harness that built an engine per delivery would be measuring
 * something no deployment has. There is one here, and the deliveries share it.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { workflow } from "@alexkroman1/aai";
import type fc from "fast-check";
import { type JournalWrite, recordJournal } from "./_workflow-journal-log.ts";
import { COLLIDING_STARTS } from "./_workflow-laws-harness.ts";
import { measure, type Stats } from "./_workflow-reach-harness.ts";
import { silent } from "./_workflow-resume-harness.ts";
import { type Program, type Recorder, runProgram, tokensOf } from "./_workflow-resume-program.ts";
import {
  type Arm,
  createOpLog,
  deliveredTokens,
  type Ev,
  scheduleJournal,
} from "./_workflow-schedule-harness.ts";
import { byCodeUnit, createTally, journalOutcome } from "./_workflow-tally-harness.ts";
import { createWorkflowEngine, type WorkflowEngine } from "./workflow-engine.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { isTerminalStatus, type JournalStore, type RunStatus } from "./workflow-journal-types.ts";
import { createMemoryStreams } from "./workflow-streams.ts";

/** The primary run's id. Every start in its burst mints it, so they collide. */
const RUN_ID = "wrun_concurrent";

/**
 * The SECOND run's id, when a scenario carries a companion.
 *
 * `createStepGate` is one gate for the ENGINE, deliberately — *"what it protects
 * is process memory, and a deployed guest serves every run of its slug"* — and
 * every generated scenario in this repo had exactly one run, so the cross-run
 * behaviour that is the whole reason the gate is engine-wide was exercised by
 * nothing. A companion at `stepConcurrency: 1` is what reaches it: the two runs'
 * steps really do queue behind one another, and a gate that was not re-entrant
 * would wedge both — the deadlock `workflow-step-gate.ts` records, which at the
 * default width *"wedge[s] every workflow in the agent"*.
 */
const COMPANION_ID = "wrun_companion";

/** Delivery rounds one scenario may take before it is declared stuck. */
const MAX_ROUNDS = 12;

/**
 * Attempts one signaller makes per round to land inside a wait's window.
 *
 * More than one, and spaced by a scheduler turn, because the window that
 * `closeHook`'s compare-and-set decides is a few scheduling points wide — from a
 * wait's `claimHook` to its `closeHook` — and a `deliverHook` released before the
 * body registered the wait answers `false` and is spent.
 */
const SIGNAL_ATTEMPTS = 4;

/** Knobs one concurrent scenario takes. */
export type ConcurrentOptions = {
  scheduler: fc.Scheduler;
  /** Concurrent `execute` calls per round. */
  deliveries: number;
  stepConcurrency: number;
  arm: Arm;
  /** Round (1-based) whose deliveries a `cancel` is issued alongside. */
  cancelRound?: number | undefined;
  /**
   * A SECOND run of this engine, driven alongside the first.
   *
   * Hook-free by contract, and the contract is the store's: a token is unique
   * ACROSS runs, so two runs of one labelled program derive the same `tok0` and
   * the second's `claimHook` throws by design. `workflow-concurrent-delivery.test.ts`
   * generates it from a grammar with no `hook` node for that reason.
   */
  companion?: Program | undefined;
  /**
   * The store underneath the scheduler. Defaults to a fresh memory journal.
   *
   * A caller passes one only to INJECT a defect — see
   * `_workflow-defective-journal.ts`. That is what makes the five laws
   * falsifiable: a law that has never been seen to fire is indistinguishable
   * from a law that cannot, and `workflow-interleavings.test.ts` is where each
   * one is shown to fire on a named, frozen interleaving.
   */
  journal?: JournalStore | undefined;
};

/** What one concurrent scenario did. */
export type ConcurrentScenario = {
  /**
   * The PRIMARY run's id.
   *
   * Carried so the laws can filter the op log by run: with a companion sharing
   * the engine, every `setStatus` in the log is a candidate terminal move and
   * law 3 counted the companion's as a second delivery of this run — which is a
   * violation report for a healthy pair, and the first thing the cross-run case
   * found when it landed.
   */
  runId: string;
  status: RunStatus | undefined;
  output: unknown;
  error: string | undefined;
  /** Journal keys, sorted, so two runs compare as sets. */
  keys: string[];
  /** Step NAME to how many times its body really ran. */
  counts: Record<string, number>;
  total: number;
  rounds: number;
  /** Every walk that ran the body to an answer, in completion order. */
  walkOutputs: unknown[][];
  /** Inputs of the `start` calls that RESOLVED. */
  startsWon: unknown[];
  /** The input the run record actually carries. */
  recordInput: unknown;
  /** Tokens a `deliverHook` accepted. */
  delivered: Set<string>;
  log: readonly Ev[];
  /**
   * The durable WRITES, in the order they landed — see
   * `_workflow-journal-log.ts` for why this is not the op log beside it.
   *
   * Carried so `checkJournalInvariants` can be evaluated over an interleaved
   * run. It reaches claims the five laws do not: law 2 compares a step entry's
   * `{status, output}`, so a second walk overwriting an entry with the same
   * answer but its own `attempts` and `finishedAt` is invisible to it and is
   * exactly what `appendStep`'s first-writer-wins rule exists to prevent.
   */
  writes: readonly JournalWrite[];
  stats: Stats;
  /** The companion run's own answer, when the scenario carried one. */
  companion?: CompanionRun | undefined;
};

/**
 * What the second run reached.
 *
 * Deliberately thinner than the primary's: the claim it carries is that sharing
 * one engine's gate did not change its ANSWER, and per-step invocation counts
 * would need a second recorder whose numbers no law reads.
 */
export type CompanionRun = {
  status: RunStatus | undefined;
  output: unknown;
  error: string | undefined;
  keys: string[];
};

/** Everything the round loop mutates, so the loop body can be its own function. */
type Drive = {
  engine: WorkflowEngine;
  /** The UNWRAPPED journal, which the driver's own bookkeeping goes through. */
  raw: JournalStore;
  scheduler: fc.Scheduler;
  who: AsyncLocalStorage<string>;
  tokens: { token: string; mode: string }[];
  answered: Set<string>;
  deliveries: number;
  cancelRound: number | undefined;
  /** Every run this engine is driving — the primary, plus a companion or not. */
  runIds: string[];
  /** Set when a round answered a wait, so the loop delivers again to read it. */
  progressed: boolean;
};

/**
 * One round: `deliveries` concurrent `execute` calls, a signaller per
 * outstanding token, and — on the chosen round — a `cancel`, all issued at once
 * so the scheduler places their journal calls against each other.
 *
 * Nothing is INJECTED at a step boundary the way the two crash models inject a
 * kill: the cancel and the signals are ordinary concurrent operations, and where
 * they land is the scheduler's decision and shrinks with the rest of it.
 */
async function runRound(drive: Drive, round: number): Promise<void> {
  const ops: Promise<unknown>[] = [];
  drive.progressed = false;
  // The operation id is PREFIXED by its run, which is what lets `measure` tell a
  // cross-run overlap from two deliveries of one run.
  for (const runId of drive.runIds) {
    const tag = runId === RUN_ID ? "p" : "c";
    for (let i = 0; i < drive.deliveries; i++) {
      ops.push(drive.who.run(`${tag}.d${round}.${i}`, () => drive.engine.execute(runId)));
    }
  }
  for (const [j, hook] of drive.tokens.entries()) {
    if (drive.answered.has(hook.token)) continue;
    ops.push(drive.who.run(`p.sig${round}.${j}`, () => signalUntilTaken(drive, hook.token)));
  }
  if (drive.cancelRound === round) {
    ops.push(drive.who.run(`p.cancel${round}`, () => drive.engine.cancel(RUN_ID)));
  }
  // `waitFor` releases scheduled tasks until the burst settles, so a starved
  // task cannot hang the property the way `waitAll` on a quiesced scheduler can.
  await drive.scheduler.waitFor(Promise.all(ops));
}

/** Try this token until it is taken or the attempts run out — see {@link SIGNAL_ATTEMPTS}. */
async function signalUntilTaken(drive: Drive, token: string): Promise<void> {
  for (let attempt = 0; attempt < SIGNAL_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await drive.scheduler.schedule(Promise.resolve(), `signal retry ${token}`);
    }
    if (await drive.engine.signal(token, { ok: token })) {
      drive.answered.add(token);
      drive.progressed = true;
      return;
    }
  }
}

/**
 * Can anything still move this run?
 *
 * Three ways yes, and the middle one is a bug this function shipped with: a
 * round that ANSWERED the wait its walks were parked on has to deliver again for
 * a walk to READ the answer, and without that the loop broke on a healthy
 * `running` run and every law that reads a terminal status fired. A liveness
 * failure in the driver looks exactly like a liveness failure in the engine,
 * which is the argument for making it one line with a name.
 */
async function advance(drive: Drive): Promise<boolean> {
  let live = false;
  for (const runId of drive.runIds) {
    const record = await drive.raw.getRun(runId);
    if (!(record && isTerminalStatus(record.status))) live = true;
  }
  if (!live) return false;
  // Driver bookkeeping goes through the RAW journal, so waking a sleep is not
  // itself an interleaving the log has to explain.
  for (const runId of drive.runIds) {
    if ((await drive.raw.wakeSleeps(runId, undefined)) > 0) return true;
  }
  if (drive.progressed) return true;
  // A `timeout` wait never suspends, so an unanswered one is not what the run is
  // parked on — only a wait that can still be answered keeps the loop going.
  return drive.tokens.some((hook) => hook.mode !== "timeout" && !drive.answered.has(hook.token));
}

/**
 * Run one generated program under overlapping deliveries.
 *
 * {@link COLLIDING_STARTS} `start` calls race for one minted id, always: the id
 * is the caller's, so `JournalStore.createRun` promises that "a collision means
 * two starts raced and exactly one may win", and nothing generated was testing
 * it. Their inputs DIFFER, which is what makes the loser observable — see law 5.
 */
export async function runConcurrentScenario(
  program: Program,
  options: ConcurrentOptions,
): Promise<ConcurrentScenario> {
  // The write log sits UNDER the scheduler and over the store, so it records
  // effects in the order they landed whatever order the scheduler released them
  // in — including the driver's own bookkeeping, which is a real write.
  const recorded = recordJournal(options.journal ?? createMemoryJournal());
  const raw = recorded.journal;
  const log = createOpLog();
  const who = new AsyncLocalStorage<string>();
  const journal = scheduleJournal(raw, {
    scheduler: options.scheduler,
    log,
    arm: options.arm,
    by: () => who.getStore() ?? "driver",
  });

  const tally = createTally();
  const walkOutputs: unknown[][] = [];
  /**
   * The PRIMARY run's bookkeeping.
   *
   * The companion's body reports through {@link idleRecorder} instead: the
   * claim it carries is that sharing one engine's gate did not change its
   * answer, and pooling its invocations into these counters would make law 1's
   * per-name floor read a number no oracle predicts.
   */
  const rec: Recorder = {
    ...tally.counted,
    // Nothing to inject — see {@link runRound}. The two crash models kill a
    // worker or cancel the run from HERE; here both the cancel and the signals
    // are ordinary concurrent operations, so this hook has no work to do.
    after: () => Promise.resolve(),
  };

  // Which id the next `start` mints. Set per burst rather than derived from a
  // counter, so a colliding burst really does collide whatever order the
  // scheduler releases it in.
  let minting = RUN_ID;
  const engine: WorkflowEngine = createWorkflowEngine({
    workflows: {
      generated: workflow({
        description: "generated",
        run: async (_input, ctx) => {
          // ONE body serving both runs, dispatched on `ctx.runId` — which is
          // also the only way the companion can have its own recorder without a
          // second declared workflow, and a second workflow key would give the
          // two runs two entries in the registry rather than two runs of one.
          if (ctx.runId !== RUN_ID) {
            return runProgram(options.companion ?? program, ctx, idleRecorder());
          }
          const output = await runProgram(program, ctx, rec);
          // Every walk that reached an ANSWER, which is what the agreement law
          // compares. A walk that suspended or aborted records nothing.
          walkOutputs.push(output);
          return output;
        },
      }),
    },
    journal,
    streams: createMemoryStreams(),
    // Held back: this driver decides when a delivery happens.
    dispatch: () => undefined,
    newRunId: () => minting,
    stepConcurrency: options.stepConcurrency,
    logger: silent,
  });

  const startsWon = await raceStarts(engine, who, options.scheduler, "p");
  const runIds = [RUN_ID];
  if (options.companion) {
    minting = COMPANION_ID;
    await raceStarts(engine, who, options.scheduler, "c");
    runIds.push(COMPANION_ID);
  }
  const drive: Drive = {
    engine,
    raw,
    scheduler: options.scheduler,
    who,
    tokens: tokensOf(program),
    answered: new Set<string>(),
    deliveries: options.deliveries,
    cancelRound: options.cancelRound,
    runIds,
    progressed: false,
  };

  let rounds = 0;
  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    await runRound(drive, rounds);
    if (!(await advance(drive))) break;
  }

  // Read BEFORE the literal, and conditionally, rather than as a guarded spread
  // in it (`guard-invariants` rule 22): the field is present-or-absent and its
  // value costs two journal reads, so the guard has to keep the reads off the
  // no-companion path — which a conditional spread does and `omitUndefined`
  // would not. `CompanionRun | undefined` is the field's declared type, so
  // there is nothing to omit.
  const companion = options.companion ? await readCompanion(raw) : undefined;
  // `recordInput` is this harness's alone (the collision law reads it), so the
  // run row is fetched here rather than widening `journalOutcome`'s answer for
  // one caller. It is a memory journal; the second lookup is a map read.
  const record = await raw.getRun(RUN_ID);
  return {
    companion,
    runId: RUN_ID,
    ...(await journalOutcome(raw, RUN_ID, tally)),
    rounds,
    walkOutputs,
    startsWon,
    recordInput: record?.input,
    delivered: deliveredTokens(log.events),
    log: log.events,
    writes: recorded.writes,
    stats: measure(log.events, walkOutputs),
  };
}

/** A recorder that counts nothing — the companion's, see the primary's. */
function idleRecorder(): Recorder {
  let seq = 0;
  return {
    count: () => ++seq,
    // Never 1, so a `flaky` leaf in a companion program cannot throw. The
    // companion's grammar excludes it anyway; this keeps the two independent.
    runs: () => 2,
    after: () => Promise.resolve(),
  };
}

/** The companion run's answer, read straight off the journal. */
async function readCompanion(raw: JournalStore): Promise<CompanionRun> {
  const record = await raw.getRun(COMPANION_ID);
  return {
    status: record?.status,
    output: record?.output,
    error: record?.error?.message,
    keys: (await raw.readSteps(COMPANION_ID)).map((entry) => entry.key).sort(byCodeUnit),
  };
}

/** Start one run {@link COLLIDING_STARTS} times at once, and answer which won. */
async function raceStarts(
  engine: WorkflowEngine,
  who: AsyncLocalStorage<string>,
  scheduler: fc.Scheduler,
  tag: string,
): Promise<unknown[]> {
  const inputs = Array.from({ length: COLLIDING_STARTS }, (_unused, n) => ({ n }));
  const won: unknown[] = [];
  await scheduler.waitFor(
    Promise.all(
      inputs.map((input, i) =>
        who.run(`${tag}.start${i}`, async () => {
          try {
            await engine.start("generated", [input]);
            won.push(input);
          } catch {
            // The refusal law 5 is about. Counted off the log by `measure`.
          }
        }),
      ),
    ),
  );
  return won;
}
