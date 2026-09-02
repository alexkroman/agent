// Copyright 2026 the AAI authors. MIT license.
/**
 * The slice of the Workflow DevKit `ctx.workflows` touches, as TYPES.
 *
 * Its own module so the two halves of the seam can name it without either
 * importing the other: `workflow-client.ts` takes it as a parameter (which is what
 * lets its specs run with no world), and `workflow-wdk.ts` is the only module in
 * this package that implements it against the real DevKit. Both used to import it
 * from the client, which made the module that must NOT reach the engine the
 * declaring one.
 *
 * Split out of `workflow-client.ts` when that file crossed the file-length cap;
 * these are the part of it that is a contract rather than an implementation.
 */

/**
 * The slice of the Workflow DevKit this client touches.
 *
 * A seam rather than a direct import, and the reason is testability rather than
 * abstraction for its own sake: `workflow/api`'s `start` resolves a World from
 * the environment at call time, so a unit test of "does `start` validate its
 * input before creating a run" would otherwise need a real Postgres or a
 * `.workflow-data/` directory to answer.
 */
export type WdkAdapter = {
  /** `start({ workflowId }, [input])` — resolves the new run's id. */
  start(workflowId: string, args: unknown[]): Promise<string>;
  /** `world.runs.get(runId)` — the raw record, or undefined when there is none. */
  getRun(runId: string): Promise<WdkRunRecord | undefined>;
  /**
   * `world.runs.list({ workflowName })` — newest first, at most `limit`.
   *
   * Takes the compiler's `workflowId`, NOT the declared name: that field holds
   * the machine-readable identifier, so filtering it by the key an agent
   * declares a workflow under matches nothing and reports no runs at all.
   */
  listRuns(workflowId: string, limit: number): Promise<WdkRunRecord[]>;
  /** `getRun(runId).cancel()` — resolves false when the run was already terminal. */
  cancel(runId: string): Promise<boolean>;
  /**
   * `getRun(runId).wakeUp()` — resolves how many pending sleeps were
   * interrupted, and `0` for a run that is gone.
   */
  wakeUp(runId: string, correlationIds: string[] | undefined): Promise<number>;
  /**
   * `resumeHook(token, payload)` — resolves false when no hook holds `token`.
   *
   * Addressed by TOKEN rather than by run id, which is WDK's own shape and the
   * right one: the caller signalling knows what it is answering, not which run
   * happens to be asking. Same throw-vs-answer translation as `cancel` — a
   * token nothing is listening on is an answer.
   */
  signal(token: string, payload: unknown): Promise<boolean>;
  /**
   * `getRun(runId).getReadable(options)` — the run's own written stream.
   *
   * Synchronous in WDK and here, because the underlying read is LAZY: it defers
   * the run lookup and the encryption-key resolution until a chunk is actually
   * pulled, which is what keeps an unread stream from costing anything.
   */
  readStream(runId: string, options: WdkStreamOptions): ReadableStream<unknown>;
  /**
   * `getReadable().getTailIndex()` — the index of the last chunk written so far,
   * or `-1` for a stream nothing has written to.
   *
   * This is what makes a progress read TERMINATE, and it is not optional. A WDK
   * stream reports `done` only once it has been CLOSED, and a progress channel
   * written by one step after another is never closed — there is no point at
   * which a step knows it is the last. So a reader that waits for the end waits
   * forever, even on a completed run. The tail is the bound instead.
   */
  streamTail(runId: string, options: WdkStreamOptions): Promise<number>;
  /**
   * The completed run's return value, hydrated.
   *
   * Separate from `getRun` because reading it costs a deserialization (and,
   * with encryption on, a key resolution) that a `pending` run has no use for.
   *
   * **What CALLS it is `toSnapshot`'s fallback**, and that is the reason it is
   * still here rather than a name kept in case somebody wants it. {@link
   * WdkRunRecord.output} is optional, so an adapter written against an earlier
   * epoch legitimately carries no value on the record — the retained epoch-2
   * template is precisely that adapter — and for one of those this is the only
   * path to a result. It is not called at all for an adapter that carries the
   * key, which is every one in this repo.
   */
  readOutput(runId: string): Promise<unknown>;
};

/** What {@link WdkAdapter.readStream} passes through to WDK. */
export type WdkStreamOptions = {
  namespace?: string | undefined;
  startIndex?: number | undefined;
};

/**
 * A WDK run record, narrowed to the fields a snapshot is built from.
 *
 * `status` is typed as the WDK union rather than ours even though the two are
 * pinned equal (`workflow-status-align.test.ts`), because this type describes
 * what WDK returns; the mapping to ours is `toSnapshot`'s job.
 */
export type WdkRunRecord = {
  runId: string;
  /**
   * The COMPILER's identifier for the workflow (the `workflowId`), which is
   * what WDK stores under this name. `toSnapshot` translates it to the declared
   * key before anyone reads it.
   */
  workflowName: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  createdAt: Date | number;
  /**
   * The run's return value, set on a `completed` record and on no other.
   *
   * On the record rather than behind {@link WdkAdapter.readOutput} because the
   * store that answers `getRun` already read it: `completed` is TERMINAL, so a
   * second read cannot see a newer value, and a snapshot of a finished run was
   * costing two platform round trips for one fact.
   *
   * **Optional, so `toSnapshot` reads it by PRESENCE of the key and falls back
   * to `readOutput` when it is absent.** An adapter that carries no `output` is
   * legal at every epoch and the retained epoch-2 template is one; when the
   * fallback was dropped, every completed run of such an adapter reported
   * `output: undefined` with nothing said anywhere. Presence rather than
   * definedness because a body that returns nothing is a completed run whose
   * output really is `undefined`.
   */
  output?: unknown;
  error?: { message: string } | undefined;
};
