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

/** Where a run is. Pinned equal to the public `WorkflowRunStatus` by its own spec. */
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** Is this status one nothing will move off? */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
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
 * The durable store, as the engine needs it.
 *
 * Deliberately has no `updateStep` and no `deleteRun`: the journal is
 * APPEND-ONLY and a run's history is what `aai workflow` reads, so a mutation
 * primitive would be a way to make a replay disagree with what an operator was
 * shown. Sweeping old runs is the platform's own job and happens below this
 * interface.
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
   */
  setStatus(
    runId: string,
    next: RunStatus,
    patch?: { output?: unknown; error?: { message: string } },
    expect?: readonly RunStatus[],
  ): Promise<boolean>;
  /** Every settled step for a run, in the order they settled. */
  readSteps(runId: string): Promise<StepEntry[]>;
  /**
   * Consume one attempt for `key` and resolve the attempt's 1-based number.
   *
   * Called BEFORE the step body runs, and that order is the whole contract: a
   * process that dies mid-step has already burned the attempt, so a step whose
   * body wedges the guest cannot be redelivered forever. It is the property the
   * DevKit's queue had, and reproducing it is why this is a separate primitive
   * rather than a field the settling entry carries — an entry is written when a
   * step FINISHES, which is exactly the event a crash denies us.
   *
   * Monotonic per `(runId, key)`. A backend implements it as an
   * upsert-and-increment; anything that reads then writes can hand the same
   * number to two concurrent deliveries and let a step exceed its ceiling.
   */
  claimAttempt(runId: string, key: string): Promise<number>;
  /**
   * Record this sleep's wake time the FIRST time it is reached, and read back
   * whatever is stored on every reach after.
   *
   * Idempotent on `key`, and that is the property the whole mechanism rests on:
   * a body is replayed, so `ctx.sleep(60_000)` is evaluated again on every
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
  ): Promise<SleepRecord>;
  /**
   * Cut short the run's outstanding waits, and resolve how many were stopped.
   *
   * `correlationIds` narrows to the waits declared with one of those ids;
   * omitted, every outstanding wait on the run is woken. A wait already woken,
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
   */
  claimHook(runId: string, key: string, token: string): Promise<HookRecord>;
  /**
   * Refuse any further signal for this wait, the window having closed.
   *
   * Called by the engine on the timeout path, BEFORE the body continues — see
   * {@link HookRecord.closed} for the divergence it prevents.
   */
  closeHook(runId: string, key: string): Promise<void>;
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
