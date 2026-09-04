// Copyright 2026 the AAI authors. MIT license.
/**
 * What a durable run IS, as five records: the run, a settled step, the two kinds
 * of wait, and the one row a boot sweep reads.
 *
 * Split from `workflow-journal-types.ts` along the seam that file already had —
 * what is STORED, versus the interface over it — when `StepEntry.startedAt`
 * pushed it past the 500-line cap. That module re-exports every name here, so an
 * importer's path is unchanged and a reader still finds a record beside the
 * method that returns it.
 *
 * **Every value here crosses a wire, so it is TYPED JSON.** `input`, `output`
 * and a failure's `error` are `unknown` and are encoded by
 * `workflow-typed-json.ts` at each backend boundary — which is why binary and
 * `Date` survive a round trip. A backend that reaches for `JSON.stringify`
 * directly turns a `Uint8Array` into an index map and the run resumes with
 * garbage rather than failing.
 *
 * @module
 */

import type { RunStatus } from "./workflow-journal-types.ts";

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
  /**
   * The bundle this run was STARTED against — `AAI_BUNDLE_SHA256`, or absent
   * off the platform and for a row that predates the column.
   *
   * A run outlives the bundle that started it, which is what makes the
   * divergence message's two-cause fork ("the CODE changed while this run was in
   * flight" versus "the BODY is non-deterministic") unanswerable from the
   * journal alone. One version here settles half of it: compared at each walk,
   * an inequality states the redeploy and an equality eliminates it.
   *
   * It is a DIAGNOSTIC and never a gate — `workflow-code-version.ts` carries
   * why a mismatch does not refuse the run, and why the value has to come from
   * the process environment rather than the agent's.
   */
  codeVersion?: string | undefined;
};

/**
 * One journal entry: a step that reached a verdict.
 *
 * Only SETTLED steps are journaled. A step that is mid-flight has no entry, so a
 * crash leaves the journal describing exactly the work that finished — which is
 * what makes replay safe to run against it without a reconciliation pass.
 *
 * `key` is `name#occurrence` — see `WorkflowContext` in the SDK for why identity is
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
  /**
   * When the walk REACHED this step, so `finishedAt - startedAt` is what it
   * cost.
   *
   * "Which step is slow" was unanswerable from the journal: an entry carried
   * `attempts` and `finishedAt` and no start, so the only thing derivable was
   * the gap between one step's finish and the next's — which is the previous
   * step's cost PLUS whatever the body did between them, and is nothing at all
   * for the first step of a run or the first after a wait. The 660 MiB
   * production case in `packages/aai-runtime/CLAUDE.md` is described in terms
   * nobody could query.
   *
   * An absolute instant rather than a `durationMs`, because the difference is
   * derivable and the instant is not: a gap between one step's `finishedAt` and
   * the next's `startedAt` is DELIVERY latency, which is a different question
   * from step cost and the one that distinguishes a slow step from a slow queue.
   *
   * It spans the whole REACH — every try and its backoff — because that is what
   * the run actually spent here. A step that succeeded on its third attempt
   * after two `Retry-After: 30`s cost a minute of the run's wall clock, and an
   * entry reporting only the last try would say the run was fast while it was
   * not; `attempts` beside it is what separates the two readings.
   *
   * It does NOT include time queued behind `StepGate`, which is taken before
   * this clock starts. Attributing contention to the step would report a fast
   * step on a loaded worker as a slow one; it shows in the GAP above instead.
   *
   * **OPTIONAL, and absence means the row predates this field.** The journal is
   * append-only over tables that already hold rows, so a run in flight when
   * this shipped has entries with no start — and a reader must render that as
   * unknown rather than as zero, which would report a long step as instant.
   * Every write sets it.
   */
  startedAt?: number | undefined;
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
 * One durable wait AND the key it is stored under — what a BULK read answers.
 *
 * `SleepRecord` is what {@link JournalStore.claimSleep} hands back, and that
 * caller already knows the key it asked about. {@link JournalStore.readSleeps}
 * answers about a whole run, so the key has to travel with the record; this is
 * exactly the relationship {@link StepEntry} has to a step's payload, which is
 * why it carries its own `key` too rather than being returned in a map.
 *
 * An array rather than a `Map` because it crosses the platform's wire as JSON,
 * where a map is not representable — the same reason `readSteps` answers one.
 */
export type SleepEntry = SleepRecord & { key: string };

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
