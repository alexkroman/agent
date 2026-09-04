// Copyright 2026 the AAI authors. MIT license.
/**
 * One read per run per tick, however many watchers a run has.
 *
 * Three loops in this package watch a run by re-reading it on a timer:
 * `workflow-api-wait.ts` (250 ms, a caller holding a request open),
 * `workflow-api-events.ts` (1 s, one SSE stream per browser tab) and
 * `workflow-notify.ts` (2 s, an announcement a tool asked for). Each justified
 * its interval the same way — the read is local, next to the world the run
 * lives in, so it costs no HTTP hop.
 *
 * **That is false on every deployed agent.** `selectJournal` puts the platform
 * arm first, so `WorkflowClient.get(runId)` is one
 * `POST /:slug/workflow-journal` over the network, and nothing between those
 * loops and the wire memoized, cached or de-duplicated anything. The
 * multiplier is the sandbox: one sandbox serves one slug fleet-wide, so three
 * tabs watching one run are three SSE streams inside ONE guest process, each
 * independently POSTing the same read once a second. Measured on the loops as
 * they were, on ONE run: three tabs plus a notify watcher cost **213 reads a
 * minute** (3.55/s), and **7.9/s** with a `wait=` request alongside. Sharing
 * takes those to 62 and 4.2/s — the tightest watcher's own rate, with everyone
 * else free. `workflow-run-reads.test.ts` is where both numbers are measured.
 *
 * So the timers are collapsed rather than the intervals lengthened — a longer
 * interval is a worse product (a page that repaints later, a synchronous call
 * that answers later) for the same saving.
 *
 * ## A COALESCER, not a cache
 *
 * The distinction is the whole safety argument, and getting it wrong would
 * trade latency for stale data, which is far worse than the cost it saves.
 * Nothing here retains a snapshot: a read that has SETTLED is gone, and a
 * watcher asking afterwards gets a fresh read. What is collapsed is only
 * CONCURRENT demand — the waiters pending when a read starts — which is
 * exactly {@link createCoalescingRunner}'s contract, and why this is built on
 * it rather than on a map of last-known values.
 *
 * ## Whoever asked soonest sets the pace
 *
 * A watcher does not subscribe to an interval; it asks for its next
 * observation with a DEADLINE ({@link RunWatch.next}). The shared timer fires
 * at the earliest deadline among the pending waiters and delivers that one read
 * to all of them — so the 250 ms synchronous caller is never slowed to the
 * stream's 1 s, and the stream is never charged for the caller's haste. Being
 * answered EARLY than asked is always legal; that is what makes the collapse
 * sound.
 *
 * ## A run that settles HERE does not have to be waited for
 *
 * The three loops above are the only entry into a watch, and nothing told the
 * watchers anything: a run that finished in THIS process was discovered by the
 * next tick of a timer, so a synchronous `POST /workflows/runs?wait=` paid up to
 * a whole 250 ms after the run was already over — on the one route whose caller
 * is holding a request open. Measured on a deployed agent, a 5-step `wait=` run
 * made 22 journal RPCs against 13 for the same run started without one.
 *
 * {@link signalRunSettled} closes that, and it pulls the pending waiters'
 * DEADLINES forward rather than pushing an answer — which is what keeps the
 * paragraph above true of it. Its own doc carries the argument.
 *
 * ## It rendezvouses on `globalThis`, and it has to
 *
 * A deployed guest has TWO copies of this package (see "A deployed guest has
 * TWO copies of this package" in this package's guide), and the three loops are
 * split across them: `createServer` — hence the wait loop and the event stream
 * — comes from the HARNESS's copy, while `createRunNotifier` is built by
 * `createRuntime` inside the BUNDLE's. Both hold the same `WorkflowClient`
 * OBJECT, so a per-reader registry unifies them — but a module-level registry
 * is one per copy, and the notifier would then poll on a timer of its own
 * beside the streams it was supposed to join. That is the same failure
 * `workflow-run-context.ts` documents, arrived at by a different route, so it
 * takes the same remedy: a `Symbol.for` slot on `globalThis`.
 */

import { createCoalescingRunner, createOwnedMap } from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { getOrCreate } from "./_get-or-create.ts";

/**
 * What a watcher needs to read. A slice of `WorkflowClient`, so a spec needs no
 * world — and the reason this type is DECLARED here rather than beside its
 * first reader: it is what the shared reads are keyed by.
 */
export type RunReader = { get(runId: string): Promise<WorkflowRunSnapshot | undefined> };

/** One watcher's handle on a run's shared reads. */
export type RunWatch = {
  /**
   * The next shared observation of this run, taken no later than `withinMs`
   * from now — and possibly sooner, when another watcher asked for one sooner.
   *
   * A `0` means "now": the read starts on this call rather than on a timer, so
   * a joining watcher never pays a tick for its first look. Rejects with
   * whatever the read threw, to EVERY watcher awaiting that read; a shared
   * failure only one caller sees is the classic coalescing bug.
   */
  next(withinMs: number): Promise<WorkflowRunSnapshot | undefined>;
  /**
   * Leave. Pending {@link next} calls reject ({@link isRunWatchClosed}), and
   * the last watcher out stops the shared timer.
   */
  close(): void;
};

/** The shared reads of one reader's runs. */
export type RunReads = {
  watch(runId: string): RunWatch;
  /** Runs with at least one live watcher. For specs asserting the drain. */
  readonly size: number;
};

function closedError(): Error {
  // A MARKER PROPERTY, not a subclass and not `instanceof`: this module has one
  // instance per copy of the package, so a class declared here would have two
  // identities and the harness's copy could not recognise an error the bundle's
  // copy threw — which is the same cross-copy trap the registry below is keyed
  // on `globalThis` to avoid.
  return Object.assign(new Error("Run watch closed"), { runWatchClosed: true });
}

/**
 * Was this rejection a {@link RunWatch.close} rather than a failed read?
 *
 * A watcher that closes its own watch already knows, so every loop here checks
 * its own flag first; this exists so a future one cannot mistake a teardown for
 * a lost database and start counting it toward a failure cap.
 *
 * @internal
 */
export function isRunWatchClosed(err: unknown): boolean {
  return isRecord(err) && err.runWatchClosed === true;
}

/**
 * Every live watch's "read now", by run id — the other half of
 * {@link signalRunSettled}.
 *
 * On `globalThis` for the reason the reader registry below is: a deployed guest
 * has two copies of this package, and the process that WALKS a run (the bundle's
 * engine) is not the one holding the `wait=` request (the harness's server). A
 * module-level map would put the signal and every listener in separate halves of
 * the same process, where the accelerator would be dead code that looks wired.
 *
 * A `Set` per run and not one entry, because those two copies each keep their
 * own {@link RunReads} and both may be watching the same run.
 */
type SettleSlot = { [RUN_SETTLED_SLOT]?: Map<string, Set<() => void>> };
const RUN_SETTLED_SLOT = Symbol.for("@alexkroman1/aai-runtime.workflowRunSettled");

const settledSlot = globalThis as SettleSlot;
settledSlot[RUN_SETTLED_SLOT] ??= new Map<string, Set<() => void>>();
const settleListeners: Map<string, Set<() => void>> = settledSlot[RUN_SETTLED_SLOT];

/**
 * Hear about {@link signalRunSettled} for one run until the returned function is
 * called.
 *
 * The removal is IDEMPOTENT, and that is what keeps this off `createOwnedMap`:
 * the entry under a run id is never REPLACED — a second watcher joins the same
 * `Set` — so the only way to evict a successor's entry is to run one listener's
 * teardown twice, which the flag makes unreachable. The empty-set delete needs
 * no identity check for the same reason nothing between the `delete` and the
 * size test can interleave.
 */
function listenForSettle(runId: string, poke: () => void): () => void {
  const listeners = getOrCreate(settleListeners, runId, () => new Set<() => void>());
  listeners.add(poke);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    listeners.delete(poke);
    if (listeners.size === 0) settleListeners.delete(runId);
  };
}

/**
 * Tell every watcher of `runId` that its next read is worth taking NOW.
 *
 * Raised by the engine when a walk in THIS process writes a run's terminal
 * status, which is the case the poll loops could only discover by waiting: the
 * answer is already in the journal by the time this is called, so the read the
 * signal brings forward is the one that would have been taken a tick later.
 *
 * It carries NO snapshot and resolves nobody — see "A run that settles HERE does
 * not have to be waited for" in this module's header for why that is the whole
 * safety argument. So it is safe to call for a run this process does not own,
 * for a status that is not terminal, and for a run nobody is watching: the worst
 * outcome in every case is one read a watcher had already asked for.
 *
 * @internal
 */
export function signalRunSettled(runId: string): void {
  const listeners = settleListeners.get(runId);
  if (!listeners) return;
  // A COPY, because a listener runs `schedule`, which can fire a read
  // synchronously, whose watcher may close and remove itself from this very set.
  for (const poke of [...listeners]) poke();
}

/** One pending `next()`. */
type Waiter = {
  /** When this caller wants an answer by. */
  dueAt: number;
  resolve: (run: WorkflowRunSnapshot | undefined) => void;
  reject: (err: unknown) => void;
};

/** One watched run. */
type Entry = {
  read: { trigger(): Promise<WorkflowRunSnapshot | undefined> };
  waiters: Set<Waiter>;
  watchers: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When {@link Entry.timer} will fire, so a later deadline cannot replace an earlier one. */
  firesAt: number | undefined;
  /**
   * A {@link signalRunSettled} that has not been spent on a read yet.
   *
   * A FLAG rather than a straight re-schedule, because the signal routinely
   * arrives while a read is already in flight — the waiters are batched and the
   * set is empty, so there is nothing to bring forward — and that read may have
   * STARTED before the status was written, which is precisely the tick the
   * signal exists to save. Held until a read is really triggered, so the waiter
   * that re-arms a microsecond later is answered immediately rather than at its
   * own deadline.
   */
  urgent: boolean;
  /** This entry's claim on the map — see {@link createOwnedMap}. */
  release: () => boolean;
  /** Stop listening for {@link signalRunSettled} — idempotent, called once. */
  unlisten: () => void;
};

/**
 * The soonest deadline among an entry's pending waiters, or `undefined` when
 * nobody is waiting.
 *
 * Its own function so `schedule` stays under the complexity cap, and because it
 * is the one place the "whoever asked soonest sets the pace" rule is computed —
 * see this module's header.
 */
function earliestDue(entry: Entry): number | undefined {
  let earliest: number | undefined;
  for (const waiter of entry.waiters) {
    if (earliest === undefined || waiter.dueAt < earliest) earliest = waiter.dueAt;
  }
  return earliest;
}

/**
 * Build the shared reads over one reader.
 *
 * Exported for specs and for a host that wants an explicitly scoped one;
 * everything in this package goes through {@link watchRun}.
 *
 * @internal
 */
export function createRunReads(reader: RunReader): RunReads {
  // Keyed by run and released by OWNERSHIP: the last watcher of a run leaving
  // while a new one arrives is the race `createOwnedMap` exists for, and the
  // hand-rolled `if (map.get(k) === mine) map.delete(k)` is banned outright
  // (`guard-invariants` rule 8).
  const entries = createOwnedMap<string, Entry>();

  const cancel = (entry: Entry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.firesAt = undefined;
  };

  const fire = (runId: string, entry: Entry): void => {
    const batch = [...entry.waiters];
    entry.waiters.clear();
    if (batch.length === 0) return;
    // SPENT here rather than when the signal arrived: a signal with no waiter to
    // hurry has bought nothing yet, and clearing it there would drop the hint on
    // exactly the case it is for — the read already in flight, whose answer
    // predates the status write.
    entry.urgent = false;
    void entry.read
      .trigger()
      .then(
        (run) => {
          for (const waiter of batch) waiter.resolve(run);
        },
        (err: unknown) => {
          // EVERY waiter of that read, not just the one that happened to
          // trigger it. A stream that kept a lost database to itself would hold
          // in silence while the others reported it.
          for (const waiter of batch) waiter.reject(err);
        },
      )
      .finally(() => schedule(runId, entry));
  };

  function schedule(runId: string, entry: Entry): void {
    // The entry may have been released while a read was in flight — the last
    // watcher left, or a successor claimed the key. `owns` is the answer to
    // both, and it is why the release is a claim rather than a delete.
    if (!entries.owns(runId, entry)) return;
    const earliest = earliestDue(entry);
    if (earliest === undefined) {
      // Nobody is waiting, so nothing is read. An entry with live watchers and
      // no pending `next()` is a loop between iterations, not a leak.
      cancel(entry);
      return;
    }
    if (!entry.urgent && entry.firesAt !== undefined && entry.firesAt <= earliest) return;
    cancel(entry);
    // An unspent signal makes the earliest deadline NOW. Being answered sooner
    // than asked is always legal — that is the same property the shared timer
    // already rests on — so this needs no agreement from the watchers.
    const delay = entry.urgent ? 0 : earliest - Date.now();
    if (delay <= 0) {
      // SYNCHRONOUSLY, not on a zero-delay timer: this is a joining watcher's
      // first look, and `waitForRun`'s whole value is that a fast run answers
      // fast. The coalescing runner is what keeps a burst of joins from each
      // taking a read of its own.
      fire(runId, entry);
      return;
    }
    entry.firesAt = earliest;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.firesAt = undefined;
      fire(runId, entry);
    }, delay);
    // Unref'd: a page watching a run, or a session waiting to be told about
    // one, must never be the reason a host stays up.
    entry.timer.unref?.();
  }

  return {
    watch(runId: string): RunWatch {
      let entry = entries.get(runId);
      if (!entry) {
        const created: Entry = {
          // `run` takes no arguments by the runner's own contract, which is
          // what makes the collapse safe: every trigger wants the same read.
          read: createCoalescingRunner(() => reader.get(runId)),
          waiters: new Set(),
          watchers: 0,
          timer: undefined,
          firesAt: undefined,
          urgent: false,
          release: () => false,
          unlisten: () => undefined,
        };
        created.release = entries.claim(runId, created);
        created.unlisten = listenForSettle(runId, () => {
          // The entry may already have been released — a listener is removed on
          // the way out, but the signal is raised from another module and this
          // is the cheap way to stay honest about it rather than the delicate
          // one. `owns` is the same question `schedule` opens with.
          if (!entries.owns(runId, created)) return;
          created.urgent = true;
          schedule(runId, created);
        });
        entry = created;
      }
      const held = entry;
      held.watchers += 1;
      const mine = new Set<Waiter>();
      let closed = false;
      return {
        next(withinMs: number): Promise<WorkflowRunSnapshot | undefined> {
          if (closed) return Promise.reject(closedError());
          const { promise, resolve, reject } = Promise.withResolvers<
            WorkflowRunSnapshot | undefined
          >();
          const waiter: Waiter = {
            dueAt: Date.now() + Math.max(0, withinMs),
            resolve: (run) => {
              mine.delete(waiter);
              resolve(run);
            },
            reject: (err) => {
              mine.delete(waiter);
              reject(err);
            },
          };
          mine.add(waiter);
          held.waiters.add(waiter);
          schedule(runId, held);
          return promise;
        },
        close(): void {
          if (closed) return;
          closed = true;
          for (const waiter of mine) {
            held.waiters.delete(waiter);
            waiter.reject(closedError());
          }
          mine.clear();
          held.watchers -= 1;
          if (held.watchers > 0) return;
          cancel(held);
          held.unlisten();
          held.release();
        },
      };
    },
    get size(): number {
      return entries.size;
    },
  };
}

/**
 * The one registry for the process — and "the process" needs saying carefully:
 * see the note on `globalThis` in this module's header, and
 * `workflow-run-context.ts` for the deployment that paid for the lesson.
 *
 * WEAK, keyed by the reader: a `WorkflowClient` is rebuilt on every `aai dev`
 * file save and one per agent in host mode, so a strong map would retain every
 * runtime a long-lived process ever built. The key is an OBJECT identity, which
 * is what lets two copies of this package agree on an entry without agreeing on
 * a string.
 */
type ReadsSlot = { [RUN_READS_SLOT]?: WeakMap<RunReader, RunReads> };
const RUN_READS_SLOT = Symbol.for("@alexkroman1/aai-runtime.workflowRunReads");

// Not `??=` in one expression: an assignment inside an expression is a lint
// error here, and the two-step form reads as what it is — adopt the registry a
// sibling copy already published, or be the copy that publishes it.
const readsSlot = globalThis as ReadsSlot;
readsSlot[RUN_READS_SLOT] ??= new WeakMap<RunReader, RunReads>();
const sharedReads: WeakMap<RunReader, RunReads> = readsSlot[RUN_READS_SLOT];

/**
 * Watch `runId` through `reader`'s shared reads, joining any watcher already
 * there.
 *
 * @internal
 */
export function watchRun(reader: RunReader, runId: string): RunWatch {
  let reads = sharedReads.get(reader);
  if (!reads) {
    reads = createRunReads(reader);
    sharedReads.set(reader, reads);
  }
  return reads.watch(runId);
}

/**
 * One read of `runId` through `reader`'s shared reads — the ONE-SHOT half of
 * {@link watchRun}, for a route that reads a run once and answers.
 *
 * Two routes do exactly that and neither went through here: `streamRunOutput`
 * opens with `engine.get(runId)` to decide `missing`/`complete`, and `readRun`
 * takes the same read whenever `?wait=` clamps to zero. Both are the reads a
 * WATCHED run attracts most of — `useWorkflowProgress` polls `/stream` once a
 * second for the life of a run, and on a deployed agent every one of those is a
 * `POST /:slug/workflow-journal` competing with that run's own journal WRITES
 * for one of the four connections `ADMIN_POOL_MAX` allows a replica. Three tabs
 * on one long run is three of those a second, none of them shared, next to an
 * `/events` stream and a notify watcher that were sharing all along.
 *
 * ## `0`, so nothing is answered from a read that STARTED BEFORE the call
 *
 * The deadline is what decides both the latency and the freshness, and here they
 * do not trade off: the shared reads retain no snapshot, so a waiter added by
 * this call is answered by a read that starts at or after it whatever the
 * deadline is. A larger one would only make a caller WAIT for a read somebody
 * else is about to take — and this route's caller is a browser holding a request
 * open, where the events stream's 1 s is latency a page can see. So `0`, which
 * costs nothing and still collapses:
 *
 * - Any watcher already PENDING on this run is drained into the same read, so a
 *   `/stream` poll answers the `/events` stream's next observation for free.
 * - Concurrent one-shot readers collapse onto {@link createCoalescingRunner}'s
 *   trailing run — N simultaneous requests cost TWO round trips rather than N,
 *   which is the shape a burst of tabs (or a client's own retry) arrives in.
 *
 * @internal
 */
export async function readRunOnce(
  reader: RunReader,
  runId: string,
): Promise<WorkflowRunSnapshot | undefined> {
  const watch = watchRun(reader, runId);
  try {
    return await watch.next(0);
  } finally {
    // Whatever happened, including the read throwing: the last watcher out is
    // what stops the shared timer and releases the entry, and a one-shot reader
    // that forgot would keep a run's entry alive for the life of the process.
    watch.close();
  }
}
