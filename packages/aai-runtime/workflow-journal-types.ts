// Copyright 2026 the AAI authors. MIT license.
/**
 * What a durable run IS, on disk: a record plus an append-only journal of steps.
 *
 * This is the contract the replay engine runs against and the one thing each of
 * the three backends implements (memory, Postgres, the platform's HTTP proxy).
 * It replaced the Workflow DevKit's `Storage` — eleven methods over sixteen
 * event types — and the shrink is the point rather than a side effect: the
 * DevKit's log is a general event stream because it has to reconstruct an
 * arbitrary execution, where this one answers exactly two questions.
 *
 * - **"Has this step already run?"** — {@link JournalStore.readSteps}, once per
 *   replay, and the engine indexes what comes back.
 * - **"Record that it has."** — {@link JournalStore.appendStep}, once per step
 *   that actually executes.
 *
 * Everything else on the interface is run LIFECYCLE, which the run API above it
 * already needed and which the DevKit was answering through a second path.
 *
 * ## Why the journal is read whole and not queried per step
 *
 * A step lookup per `ctx.step` is one round trip per step per replay, and a
 * replay reaches every step the run has ever completed — so the Nth attempt of a
 * 40-step run costs 40 round trips before it does any new work, and the cost
 * grows with progress. Reading the journal once at the top costs one, whatever
 * the run has done. A journal is small by construction (a step's output is the
 * only unbounded part, and an author who journals megabytes has a different
 * problem), so the whole-read is affordable in a way the per-step read is not.
 *
 * ## Every value here crosses a wire, so it is TYPED JSON
 *
 * `input`, `output` and a failure's `error` are `unknown` and are encoded by
 * `workflow-typed-json.ts` at each backend boundary — the same codec the
 * DevKit's storage proxy used, which is why binary and `Date` survive a round
 * trip. A backend that reaches for `JSON.stringify` directly turns a
 * `Uint8Array` into an index map and the run resumes with garbage rather than
 * failing.
 */

import { TERMINAL_WORKFLOW_STATUSES } from "@alexkroman1/aai/internal";
import type { WorkflowRunStatus } from "@alexkroman1/aai/workflow-api";

/**
 * Where a run is — the PUBLIC union, imported rather than restated.
 *
 * An earlier draft wrote the five members out here under a comment claiming they
 * were "pinned equal to the public `WorkflowRunStatus` by its own spec". No such
 * spec existed: `workflow-status-align.test.ts` pins the public union against the
 * DevKit's, which is a different claim, so this was a third hand-copy that
 * nothing checked. It is an alias now, which makes the question unaskable.
 */
export type RunStatus = WorkflowRunStatus;

/**
 * Is this status one nothing will move off?
 *
 * The SET comes from `TERMINAL_WORKFLOW_STATUSES`, which is where the repo
 * already decides this; only the predicate's shape is local, because `isTerminal`
 * takes a snapshot where the engine has a bare status. Four independent
 * statements of "which statuses are terminal" existed before this imported one
 * of them, and `workflow-engine.ts` reads it to decide whether a redelivery is a
 * no-op — so a status added to the public union would have left that check
 * silently wrong.
 */
export function isTerminalStatus(status: RunStatus): boolean {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

// Re-exported: the class is DECLARED in its own module for the file-length
// reason that module's doc gives, and this stays the path every backend and the
// engine already name. Same pattern as `StepAbandonedError` in
// `workflow-replay-step.ts`.
export { JournalConflictError } from "./workflow-journal-conflict.ts";

/**
 * A journal that can be SWEPT — one that declares
 * {@link JournalStore.resumableRuns}.
 *
 * The one member is re-declared as REQUIRED rather than derived with
 * `Required<Pick<…>>`, which does not do the job under
 * `exactOptionalPropertyTypes`: that utility drops the `?` and keeps the
 * `| undefined` in the property's own type, so every call site still needed a
 * `?.` and the narrowing bought nothing.
 */
export type ResumableJournal = JournalStore & {
  resumableRuns: (limit: number) => Promise<ResumableRun[]>;
};

/**
 * Can this journal enumerate the runs it owes a delivery?
 *
 * A PREDICATE and not a cast: `resumableRuns` is optional on the interface, so the
 * narrowing is something the checker can see rather than something a
 * `as unknown as` asserts. The one caller is the boot sweep, which needs the
 * answer to decide between sweeping and warning.
 */
export function isResumableJournal(store: JournalStore): store is ResumableJournal {
  return store.resumableRuns !== undefined;
}

/**
 * One run, as stored.
 *
 * `workflow` is the DECLARED KEY — the name the agent registered it under in
 * `agent({ workflows })`. Under the DevKit this field held a compiler-minted
 * `workflowId` and every read had to translate; there is only one identity now,
 * which is most of what the removal bought.
 */
export type RunRecord = {
  runId: string;
  workflow: string;
  status: RunStatus;
  createdAt: number;
  /** The validated input the run was started with. */
  input: unknown;
  /** Set once `status` is `completed`. */
  output?: unknown;
  /** Set once `status` is `failed`. */
  error?: { message: string } | undefined;
};

/**
 * One journal entry: a step that reached a verdict.
 *
 * Only SETTLED steps are journaled. A step that is mid-flight has no entry, so a
 * crash leaves the journal describing exactly the work that finished — which is
 * what makes replay safe to run against it without a reconciliation pass.
 *
 * `key` is `name#occurrence` — see `WorkflowCtx` in the SDK for why identity is
 * that pair and not an ordinal or a bare name.
 */
export type StepEntry = {
  key: string;
  /** The step's own name, without the occurrence suffix — for `aai workflow` output. */
  name: string;
  /** `ok` carries `output`; `failed` carries `error` and ended the run. */
  status: "ok" | "failed";
  output?: unknown;
  error?: { message: string } | undefined;
  /** Attempts this step consumed, counting the one that settled it. */
  attempts: number;
  finishedAt: number;
};

/**
 * One durable WAIT, as stored.
 *
 * Unlike a {@link StepEntry} this is MUTABLE, and the difference is real rather
 * than an inconsistency: a step entry records something that happened, where a
 * sleep records something that has not happened yet. `wake` is what changes it,
 * which is the whole point of `ctx.workflows.wake(runId)` — a scheduled wait a
 * caller decides to cut short. An append-only log cannot express that without a
 * tombstone convention every backend would have to agree on.
 */
export type SleepRecord = {
  /** When the body may continue. Decided ONCE, on the first reach. */
  wakeAt: number;
  /** Set by {@link JournalStore.wakeSleeps}. A woken sleep returns immediately. */
  woken: boolean;
  /** What a targeted `wake` matches on, when the author named one. */
  correlationId?: string | undefined;
  /**
   * What this wait IS, which decides whether a broad wake may end it.
   *
   * A `waitFor(token, { timeoutMs })` journals its deadline through the same
   * primitive as a `ctx.sleep`, and without this they were indistinguishable — so
   * `ctx.workflows.wakeUp(runId)` with no ids, which is the "send it now" call a
   * tool makes to cut a SCHEDULE short, also closed any pending approval window
   * on that run. A body cancelling a human approval it never asked to cancel.
   *
   * A bare wake therefore reaches `sleep` only. A hook's deadline is ended by
   * naming its correlation id, or by the answer arriving.
   */
  kind: "sleep" | "hookTimeout";
};

/**
 * One outstanding HOOK: a body parked on somebody else's answer.
 *
 * Mutable for the reason {@link SleepRecord} is — it records something that has
 * not happened yet. It differs in being addressed from OUTSIDE the run: a
 * signaller knows the token, not the run id, which is why the store carries a
 * token index and why `token` is unique across runs rather than per run.
 */
export type HookRecord = {
  token: string;
  /** True once somebody signalled. `payload` is only meaningful then. */
  delivered: boolean;
  payload?: unknown;
  /**
   * True once the wait's WINDOW closed unanswered, so no signal may be taken.
   *
   * Not cosmetic, and not the same as `delivered`. A body whose
   * `waitFor(token, { timeoutMs })` timed out has already returned `undefined`
   * and moved on; if a signal could still land, the next replay would read a
   * payload, take the ANSWERED branch, and the two walks of the body would
   * disagree about what happened. Closing it is what keeps the answer a fact.
   */
  closed?: boolean;
};

/**
 * One run a local dispatcher still owes a delivery, as {@link
 * JournalStore.resumableRuns} answers it.
 */
export type ResumableRun = {
  runId: string;
  /**
   * The earliest OUTSTANDING deadline the run is waiting on, or absent when it is
   * waiting on nothing — a `pending` run whose start was never delivered, or one
   * killed mid-step. Absent means "deliver now"; a value in the past means the
   * same and says how overdue it is.
   */
  wakeAt?: number | undefined;
};

/**
 * The durable store, as the engine needs it.
 *
 * Deliberately has no `updateStep` and no `deleteRun`: the journal is
 * APPEND-ONLY and a run's history is what `aai workflow` reads, so a mutation
 * primitive would be a way to make a replay disagree with what an operator was
 * shown. Sweeping old runs is the platform's own job and happens below this
 * interface.
 *
 * ## Four of these need a run, and what happens without one is UNDER-SPECIFIED
 *
 * {@link JournalStore.claimAttempt}, {@link JournalStore.claimSleep},
 * {@link JournalStore.claimHook} and {@link JournalStore.appendStep} are defined
 * only for a run that EXISTS. A backend MAY throw — memory does; both databases
 * insert a row with no run to belong to and answer normally. Deliberately left
 * under-specified: the engine calls these only after `createRun`, mandating the
 * throw costs the databases a read or a foreign key per step to detect a state
 * it cannot reach, and mandating the answer would have memory invent a slot,
 * i.e. resurrect a run.
 */
export type JournalStore = {
  /**
   * Create the run record. Rejects if `runId` already exists — the id is minted
   * by the caller, so a collision means two starts raced and exactly one may win.
   */
  createRun(record: RunRecord): Promise<void>;
  /** One run, or `undefined` when there is none. */
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** Newest first, at most `limit`, filtered to one declared workflow key. */
  listRuns(workflow: string, limit: number): Promise<RunRecord[]>;
  /**
   * Move a run's status, and with it the terminal payload.
   *
   * `expect` is a COMPARE-AND-SET on the current status, and it is what stops
   * two deliveries of the same message both completing a run. A backend that
   * cannot do this atomically must say so rather than approximating it: the
   * failure it prevents is a cancelled run being marked `completed` by a worker
   * that had not noticed.
   *
   * Resolves `false` when the run was not in `expect`.
   *
   * **The patch is ADDITIVE.** A field it does not carry is not written, and an
   * explicit `undefined` is the same as absent — so a stored `output` can never
   * be CLEARED. That is what `error` has always done in all three backends, so
   * the alternative leaves two fields of one patch with two rules; the platform
   * cannot express the distinction at all without a new wire field
   * (`JSON.stringify` drops an `undefined` key, so "no patch" and "clear it" are
   * already the same bytes); and unwriting a terminal payload is the mutation
   * primitive this interface says outright it does not have.
   */
  setStatus(
    runId: string,
    next: RunStatus,
    patch?: { output?: unknown; error?: { message: string } },
    expect?: readonly RunStatus[],
  ): Promise<boolean>;
  /**
   * Every settled step for a run, ordered by `finishedAt`, ties broken by `key`.
   *
   * The tie is what the wording pins down, and it used to say "in the order they
   * settled" — which memory implemented as insertion order while both databases
   * ran `order by finished_at, key`, so two steps of one fan-out settling inside
   * one millisecond came back in opposite orders depending on where the run was
   * deployed. The databases are right and memory sorts now.
   *
   * One limit stated rather than pretended away: a database breaks the tie in
   * the column's COLLATION, which for `text` under a non-C collation is not
   * code-unit order — and step keys are punctuation-heavy (`fetch#0`,
   * `sleep!0`). So a BYTE-EXACT tie order is not promised without
   * `collate "C"` on the column. It is unobservable in practice: a tie needs two
   * steps settling within one millisecond, and the engine indexes what this
   * returns by `key`.
   */
  readSteps(runId: string): Promise<StepEntry[]>;
  /**
   * Charge one attempt for `key` and resolve the attempt's 1-based number.
   *
   * Called BEFORE the step body runs, and that order is the whole contract: a
   * process that dies mid-step has already burned the attempt, so a step whose
   * body wedges the guest cannot be redelivered forever. It is the property the
   * DevKit's queue had, and reproducing it is why this is a separate primitive
   * rather than a field the settling entry carries — an entry is written when a
   * step FINISHES, which is exactly the event a crash denies us.
   *
   * **A charge is a LEASE, not a tally** — see {@link JournalStore.releaseAttempt},
   * which gives one back. So the number this answers is not "how many times has
   * this step been tried", it is **how many attempts are outstanding right now,
   * this one included**: attempts still running, plus every attempt that ended
   * in no outcome at all because the worker holding it died. That is the
   * quantity a pre-body ceiling was always trying to bound. It used to be a bare
   * tally, and the difference is a durable-execution defect rather than a nuance
   * — a suspend, a duplicate delivery and an in-process retry each spent from
   * one budget that only a crash was supposed to spend, so two overlapping
   * deliveries of a step whose body sleeps burned four attempts of three and the
   * loser journaled `failed` over a step that had SUCCEEDED. See
   * `workflow-replay-step.ts`, "An attempt is a lease".
   *
   * Monotonic per `(runId, key)` in the only sense that matters for correctness:
   * two concurrent charges never answer the same number. A backend implements it
   * as an upsert-and-increment; anything that reads then writes can hand the same
   * number to two concurrent deliveries and let a step exceed its ceiling.
   */
  claimAttempt(runId: string, key: string): Promise<number>;
  /**
   * Give back one attempt charged for `key`. Floored at zero.
   *
   * Called when the attempt ended in a durable WAIT — the body suspended, so the
   * run is mid-flight and the next delivery will reach this step again. That is
   * the one outcome which leaves no journal entry AND is not the condition
   * {@link JournalStore.claimAttempt}'s ceiling exists to catch. Everything else
   * either settles the step, in which case the entry is authoritative and the
   * charge is never read again, or leaves the charge deliberately standing:
   *
   * - **A death keeps it, and that asymmetry is the whole mechanism.** A worker
   *   that dies mid-body cannot release, so the charge is the only evidence the
   *   attempt happened — which is also what the divergence check reads (see
   *   `workflow-replay-divergence.ts`, "two facts decide it").
   * - **An in-process retry keeps it**, being the same walk working on the same
   *   step. A charge per TRY would leave a window between the release and the
   *   next claim in which a kill leaves no evidence at all.
   * - **An ABORT keeps it**, for the same reason a death does: the walk is over
   *   and it did not finish.
   *
   * Idempotent at the floor rather than matched to a token: a release that lands
   * twice can only under-charge a budget the next charge re-takes, where one
   * that could go negative would hand a wedging step an unbounded budget.
   *
   * The happy path therefore still costs exactly one journal round trip per
   * step: no release at all.
   */
  releaseAttempt(runId: string, key: string): Promise<void>;
  /**
   * Record this sleep's wake time the FIRST time it is reached, and read back
   * whatever is stored on every reach after.
   *
   * Idempotent on `key`, and that is the property the whole mechanism rests on:
   * a body is replayed, so `ctx.sleep("poll", 60_000)` is evaluated again on every
   * delivery. Storing the newly-computed deadline each time would push it 60
   * seconds further out per replay and the run would never wake. So the first
   * write wins and later calls are reads.
   *
   * Resolves the record now in force — the stored one when there was one.
   */
  claimSleep(
    runId: string,
    key: string,
    wakeAt: number,
    correlationId: string | undefined,
    kind?: SleepRecord["kind"],
  ): Promise<SleepRecord>;
  /**
   * Cut short the run's outstanding waits, and resolve how many were stopped.
   *
   * `correlationIds` narrows to the waits declared with one of those ids;
   * omitted, every outstanding `sleep` is woken and a hook's DEADLINE is not —
   * see {@link SleepRecord.kind} for the approval window that used to close. A wait already woken,
   * or already elapsed, is NOT counted — the number is what this call changed,
   * which is what makes `{ woken: 0 }` an answer a caller can act on rather than
   * a tie between "nothing was waiting" and "I woke something twice".
   */
  wakeSleeps(runId: string, correlationIds: readonly string[] | undefined): Promise<number>;
  /**
   * Register a hook the body is parked on, or read back what was delivered.
   *
   * Idempotent on `key`, for the same replay reason `claimSleep` is: the body is
   * re-walked on every delivery and must find the SAME hook rather than
   * registering a second one.
   *
   * A `token` already registered by a DIFFERENT run or key is a conflict and
   * throws: two waits sharing a token means one signal resolves whichever the
   * store happens to find and the other waits forever, which is a bug worth
   * failing the run over rather than resolving arbitrarily.
   *
   * **It throws a {@link JournalConflictError}**, which is what tells the engine
   * to fail the run rather than treat the store as unavailable and retry the
   * delivery forever. Every backend owes that type for this case.
   */
  claimHook(runId: string, key: string, token: string): Promise<HookRecord>;
  /**
   * Refuse any further signal for this wait, the window having closed.
   *
   * Called by the engine on the timeout path, BEFORE the body continues — see
   * {@link HookRecord.closed} for the divergence it prevents.
   *
   * A COMPARE-AND-SET on `delivered`, and the boolean is what decides the
   * branch. Unconditional, it prevented only half the divergence it is
   * documented to prevent: the engine reads the deadline, then closes, and a
   * signal landing between the two left this walk taking the TIMED-OUT branch
   * while every later replay read `delivered: true` and took the ANSWERED one.
   *
   * Resolves `true` when no signal may be taken through this window — it is
   * closed now, was already closed, or is gone entirely (a terminal run releases
   * its tokens) — so the caller may return the timeout. Resolves `false` ONLY
   * when the window was already ANSWERED, in which case the caller owes the
   * answered branch instead.
   */
  closeHook(runId: string, key: string): Promise<boolean>;
  /**
   * Deliver `payload` to whatever holds `token`.
   *
   * Resolves the run id that was waiting, or `undefined` when nothing holds the
   * token — the ORDINARY answer, since a token whose run has moved on, finished,
   * closed its window or never started is indistinguishable to a caller and
   * needs no error.
   *
   * Addressed by TOKEN rather than by run id because that is what the signaller
   * knows: it is answering a question, not driving a particular run.
   */
  deliverHook(token: string, payload: unknown): Promise<string | undefined>;
  /**
   * Every non-terminal run this journal still owes a delivery, newest deadline
   * LAST, at most `limit`.
   *
   * **The one query that is not about a single run, and the reason it exists is a
   * data-loss bug.** A `ctx.sleep` suspends with its deadline in the journal and
   * its TIMER in the dispatcher's process, and nothing enumerated the journal at
   * boot — so a run suspended when the process restarted (or when `aai dev`
   * rebuilt its runtime) sat `running` forever with its whole journal intact, on
   * every backend, Postgres included. `wake` could not rescue it either: an
   * elapsed deadline is not a wait {@link JournalStore.wakeSleeps} may stop, so
   * the run was unreachable through the public API. `createInProcessWorkflowEngine`
   * sweeps this at construction, which is the in-process half of what
   * `aai-server/workflow-queue-reconcile.ts` does for a deployed guest.
   *
   * Two membership rules, both mirroring that reconcile's predicate because it is
   * the proven version of this question:
   *
   * - **A PARK is not a stall.** `await ctx.waitFor(token)` with no deadline is
   *   the steady state of the human-approval workflow the SDK documents, and
   *   `signal` is what ends it — so a run holding an OPEN window (undelivered,
   *   unclosed) and no outstanding sleep is EXCLUDED. Including it would cost a
   *   replay per parked run per boot, which under `aai dev` is per file save.
   * - **A run with an outstanding sleep is included whatever its kind**, so a
   *   `waitFor(token, { timeoutMs })` whose deadline was lost still fires. That is
   *   the qualification that keeps the park rule from hiding a run forever.
   *
   * **OPTIONAL, and an absent implementation is a DECLARATION.** A backend that
   * cannot answer omits it, and `createInProcessWorkflowEngine` then WARNS at boot
   * rather than silently forgetting the runs — a durability tradeoff absent from
   * the log reads as a bug. `workflow-journal-platform.ts` is the one backend that
   * omits it on purpose: a deployed guest's schedule lives in the platform's
   * queue, whose reconcile already recovers a lost one server-side, so a sweep
   * here would be a second recovery mechanism booting a sandbox per copy. See
   * that module's own note.
   */
  resumableRuns?: ((limit: number) => Promise<ResumableRun[]>) | undefined;
  /**
   * Append one settled step.
   *
   * Idempotent on `key`: a redelivery that re-runs a step whose entry landed
   * just before the crash must not produce a second entry. Resolves the entry
   * that is now authoritative — the one already stored, when there was one — so
   * the engine returns the FIRST result rather than its own, which is what keeps
   * a replay deterministic across a double execution.
   */
  appendStep(runId: string, entry: StepEntry): Promise<StepEntry>;
};
