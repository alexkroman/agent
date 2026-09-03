// Copyright 2026 the AAI authors. MIT license.
/**
 * The two durable WAITS a workflow body may reach: `ctx.sleep` and `ctx.waitFor`.
 *
 * Split out of `workflow-replay.ts` at the seam `createDeterminismReads` already
 * drew — a `Pick<WorkflowCtx, …>` factory bound to one walk, taking the walk's
 * journal, its suspension channel and its refusal callback. That file is the one
 * two changes at a time land in and it sits against the 500-line cap; naming the
 * waits took it over.
 *
 * ## A wait is keyed by NAME, and that is recent
 *
 * `sleep!<label>#<occurrence>` and `hook!<token>#<occurrence>` — name plus
 * occurrence, exactly like `ctx.step`. Two properties come out of that shape and
 * both are load-bearing:
 *
 * - **`!` is not producible by `${name}#${occurrence}`**, so an author's own
 *   `ctx.step("sleep")` (`sleep#0`) cannot alias a durable wait
 *   (`sleep!sleep#0`). The two key spaces are disjoint by construction rather
 *   than by convention, which is the same trick `workflow-replay-determinism.ts`
 *   uses for `now!`/`random!`/`uuid!`.
 * - **The occurrence goes LAST**, so `(name, occurrence)` is recoverable from the
 *   key by splitting at the final `#` however many a label or token carries.
 *
 * They were two bare ordinals, advanced only when a wait was REACHED, so a body
 * reaching a different NUMBER of waits read its predecessor's record — a
 * week-long `ctx.sleep` behind an `if` skipped in full with the clock unmoved and
 * the run reporting `completed`, and the `waitFor` version handing the body
 * another wait's PAYLOAD. `workflow-replay-divergence.ts` carries the residual:
 * a label or token that is ITSELF non-deterministic still mints a fresh key, so
 * the run parks on something nobody can signal — a hang rather than a wrong
 * answer, and nothing's job to catch.
 *
 * ## Nothing here THROWS a suspension
 *
 * A wait that has not elapsed hands back `slot.park(…)`, a promise that never
 * settles, and the walk suspends on a channel the body holds no reference to.
 * The `finally` closing the slot is what marks this engine operation done for
 * quiescence — see `workflow-replay-suspend.ts`. What DOES throw is a REFUSAL,
 * which is a verdict about the walk and travels through `refuse` as well, so a
 * body that catches broadly cannot turn one into `completed`.
 *
 * ## A payload is CHECKED after the window has been decided, and never reopens it
 *
 * `WaitForOptions.schema` is the first thing that verifies what a stranger sent
 * — `answered.payload as T` and `record.payload as T` were casts, over a value
 * that arrived on an unauthenticated public route. `workflow-replay-schema.ts`
 * carries why a failure is FATAL; what belongs here is where in the sequence it
 * runs, because the ordering is not free to change.
 *
 * The deadline arm decides the window BEFORE the body continues: `closeHook` is a
 * compare-and-set, and that is what stops a signal landing a moment later from
 * making the next replay answer a window this one timed out (`HookRecord.closed`).
 * A payload is therefore only ever validated on a wait that is already CLAIMED —
 * either delivered on entry, or delivered because the compare-and-set refused —
 * and the validation deliberately does not undo that claim.
 *
 * **A rejected payload leaves the hook exactly as it found it: answered.** Three
 * reasons, in order of how badly they bite. The delivery HAPPENED and the sender
 * was answered on it, so a journal that showed the window still open would
 * disagree with what the far side was told. Reopening would invite a second
 * signal to overwrite the first, which turns a run that failed loudly into one
 * whose history depends on who retried. And it would not help anyway: the same
 * bytes are what every later delivery reads, which is exactly why the refusal is
 * fatal rather than retryable.
 *
 * A window that CLOSES unanswered is not a validation failure and never consults
 * the schema — there is no payload, `undefined` is the outcome the body branches
 * on, and running a schema over "nobody answered" would fail every timeout a
 * validating wait ever takes.
 * ## An ELAPSED wait is answered from the walk's snapshot
 *
 * `replayRun` opens with one `readSteps`, and a settled step is then free. Waits
 * had no such read: every `ctx.sleep` a walk reached was a `claimSleep` round
 * trip, and the answer was almost always "that finished long ago". A body that
 * polls is where that compounds, because each iteration mints a NEW key —
 * `sleep!poll#0`, `sleep!poll#1`, … — so delivery N re-claims N-1 finished waits
 * before it can do anything, and journal traffic is quadratic in the number of
 * deliveries rather than proportional to the work.
 *
 * Production, on a 34-segment transcription run: **2,675 journal POSTs in 25
 * minutes, rising +1 per delivery across 69 consecutive deliveries**, the
 * interval between deliveries growing 11s → 37s in step with the count, and the
 * run never completed. Every call succeeded; what a log shows is a run getting
 * slower.
 *
 * {@link WaitOptions.sleeps} is the missing read and {@link overInSnapshot} is
 * the rule for using it, which is NARROWER than the step one because
 * `claimSleep` is a claim rather than a read. Both `ctx.sleep` and the deadline
 * half of `ctx.waitFor` take that arm.
 *
 * **`claimHook` still round-trips on every reach, and that is a known
 * residual.** `delivered` is monotonic the same way `woken` is, so the identical
 * argument would let a snapshot answer an already-answered hook — but hooks live
 * in their own table and would need their own bulk read, and the shape that
 * makes waits quadratic (a new key per loop iteration) is not one a body reaches
 * with `waitFor`, which parks rather than polls. Measure a body that does before
 * adding the second read.
 *
 * @module
 */

import type {
  SleepOptions,
  WaitForOptions,
  WaitForSchemaOptions,
  WorkflowCtx,
} from "@alexkroman1/aai";
import type { StandardSchemaV1 } from "@alexkroman1/aai/host-internal";
import type { JournalStore, SleepRecord } from "./workflow-journal-types.ts";
import { waitTokenDiverged } from "./workflow-replay-divergence.ts";
import { checkWorkflowValue, waitPayloadRefused } from "./workflow-replay-schema.ts";
import type { SuspendController } from "./workflow-replay-suspend.ts";
import { waitInsideStep } from "./workflow-replay-wait.ts";

/**
 * The absolute moment a `sleep(label, until)` names.
 *
 * A `Date` is taken as given; a number is a DURATION from now. Read once, at the
 * first reach, and journaled — see `JournalStore.claimSleep`.
 */
function wakeAtFrom(until: number | Date): number {
  return until instanceof Date ? until.getTime() : Date.now() + until;
}

/**
 * What a `waitFor({ timeoutMs })` found once the hook was open.
 *
 * Three members rather than the two it used to have (`{ park } | { value }`),
 * because a CLOSED window and a delivered payload of `undefined` are the same
 * value and are no longer the same outcome: only one of them has a payload for
 * a schema to check. The distinction costs a discriminant and is what stops a
 * validating wait rejecting its own timeout.
 */
type DeadlineOutcome =
  | { kind: "park"; wakeAt: number }
  | { kind: "closed" }
  | { kind: "answered"; payload: unknown };

/**
 * The deadline a wait carries, or `undefined` for an unbounded one.
 *
 * Reads the FIELD rather than testing whether options were passed at all, which
 * is the distinction the second option bag introduced: a schema alone does not
 * make a wait bounded, and `waitOptions !== undefined` used to mean "has a
 * deadline" because a deadline was the only thing options could carry.
 */
function deadlineOf(
  waitOptions: WaitForOptions | WaitForSchemaOptions | undefined,
): number | undefined {
  if (waitOptions === undefined || !("timeoutMs" in waitOptions)) return undefined;
  return waitOptions.timeoutMs;
}

/**
 * May this wait be answered OVER, out of the walk's opening snapshot alone?
 *
 * This is the whole correctness argument for the snapshot, and it is narrower
 * than the step one. `ctx.step` answers from `settled` because a settled step is
 * a FACT and a journal entry is immutable; `claimSleep` is not a read at all —
 * it CREATES the record when there is none — so a snapshot miss can never be
 * answered here, and a walk that skipped the claim would leave a wait no wake and
 * no reconcile can find.
 *
 * So a `true` needs two things, and both are properties nothing can take back:
 *
 * - **the record is IN the snapshot**, so the claim has already happened and
 *   there is nothing left for this reach to create; and
 * - **the wait is over by a MONOTONIC test** — `woken` is set once and never
 *   cleared, and `wakeAt` is decided on the first reach and never moves (first
 *   write wins), so a deadline in the past stays in the past.
 *
 * Everything else round-trips exactly as before: an absent record, and a
 * future-dated unwoken one, whose `woken` a `wakeUp` may have flipped since the
 * snapshot was taken. A stale snapshot can therefore only ever be wrong in the
 * direction of taking a round trip it did not need — never of skipping a claim
 * that had to happen, and never of missing a wake.
 */
function overInSnapshot(record: SleepRecord | undefined, now: number): boolean {
  if (record === undefined) return false;
  return record.woken || now >= record.wakeAt;
}

/** What {@link createWaitMethods} needs to answer one walk's waits. */
export type WaitOptions = {
  runId: string;
  /**
   * The declared key of the workflow being walked.
   *
   * Read only by a refusal message: a hook token is DERIVED from the run's own
   * input, so it reads as data rather than as a place in the source, and the
   * workflow's name is what points a reader at the body that declared the wait.
   */
  workflow: string;
  journal: JournalStore;
  /**
   * Every wait this run had registered when the walk OPENED, by key.
   *
   * One `readSleeps` for the whole replay, taken beside the step read — see
   * `ReplayOptions.sleeps`. What it may be used for is {@link overInSnapshot}'s
   * subject; what it is FOR is that a body sleeping in a loop reaches every one
   * of its finished sleeps again on every delivery, which made journal traffic
   * quadratic in the number of deliveries.
   */
  sleeps: ReadonlyMap<string, SleepRecord>;
  /**
   * Where a wait PARKS, and the channel the walk suspends on. One per walk, so
   * its suspension value is unique to this call and recognisable by identity.
   */
  suspend: SuspendController;
  /**
   * Record a refusal the ENGINE raised about this walk.
   *
   * A callback rather than a returned value because the refusal is also THROWN,
   * and `replayRun` holds the message so a body that catches broadly cannot turn
   * it into `completed` — the same contract a divergence and a determinism read
   * inside a step have there.
   */
  refuse: (message: string) => void;
};

/**
 * The two methods, bound to one walk.
 *
 * @internal
 */
export function createWaitMethods(options: WaitOptions): Pick<WorkflowCtx, "sleep" | "waitFor"> {
  const { runId, workflow, journal, sleeps: snapshot, suspend, refuse } = options;
  /**
   * Reaches so far, per NAME — a sleep by its label, a hook by its token.
   *
   * Their own maps rather than `replayRun`'s step counter, so an author's step
   * named "cooldown" and a `ctx.sleep("cooldown", …)` count independently: the
   * `!` in the key space already keeps them from aliasing, and sharing a counter
   * would make one shift the other for no reason. Two maps rather than one for
   * the same reason `workflow-replay-determinism.ts` keeps three counters —
   * inserting a sleep must shift no hook.
   *
   * `-Counts` rather than the bare nouns because {@link WaitOptions.sleeps} is
   * the walk's RECORD snapshot: two things keyed by very nearly the same string,
   * and one shadowing the other in this scope is how a reach comes to count
   * itself against the wrong map.
   */
  const sleepCounts = new Map<string, number>();
  const hookCounts = new Map<string, number>();

  /** The next occurrence of `name` in `counts`, advancing it. */
  const nextOccurrence = (counts: Map<string, number>, name: string): number => {
    const occurrence = counts.get(name) ?? 0;
    counts.set(name, occurrence + 1);
    return occurrence;
  };

  /**
   * Refuse a wait reached inside a step, or answer `undefined` at body level.
   *
   * Called BEFORE the occurrence counter advances, so a refused call leaves the
   * key space untouched and the failure names one cause rather than two — and,
   * more importantly, before the wait is CLAIMED: a claimed wait inside a step
   * parks on a promise that cannot settle and the delivery never returns.
   */
  function refuseInsideStep(method: string): Error | undefined {
    const noWait = waitInsideStep(method);
    if (!noWait) return undefined;
    refuse(noWait.message);
    return noWait;
  }

  async function sleep(
    label: string,
    until: number | Date,
    sleepOptions?: SleepOptions,
  ): Promise<void> {
    const noWait = refuseInsideStep("ctx.sleep");
    if (noWait) throw noWait;
    const occurrence = nextOccurrence(sleepCounts, label);
    const key = `sleep!${label}#${occurrence}`;
    // Answered from the walk's opening read, and no slot is entered — this does
    // no engine work, exactly like a `ctx.step` answered out of `settled`. It is
    // the arm that makes a polling body's journal traffic flat rather than
    // quadratic: every iteration but the current one is a sleep that finished
    // deliveries ago. See `overInSnapshot` for why only a snapshot HIT that is
    // already over may take it.
    if (overInSnapshot(snapshot.get(key), Date.now())) return;
    const slot = suspend.enter();
    try {
      const record = await journal.claimSleep(
        runId,
        key,
        wakeAtFrom(until),
        sleepOptions?.correlationId,
      );
      // Woken early, or the moment has passed — either way the wait is over. A
      // deadline in the past is not an error: a run resuming after a long outage
      // meets that case legitimately, and so does every replay after the wake.
      if (record.woken || Date.now() >= record.wakeAt) return;
      // PARKED, never thrown. The body's `await` here never resumes, so no
      // `catch` sees a suspension and no `finally` runs on one.
      return slot.park(record.wakeAt);
    } finally {
      slot.end();
    }
  }

  /**
   * The DEADLINE half of a `waitFor({ timeoutMs })`, once the hook is open.
   *
   * Its own function because the two halves answer different questions — is
   * there an answer, versus has the window closed — and inlined they took
   * `waitFor` over Biome's cognitive-complexity ceiling.
   *
   * **It answers a DESCRIPTOR and never parks**, which is the one thing about
   * this split that is not a free move. `slot.park` hands back a promise that
   * never settles, so `return slot.park(x)` inside a `try`/`finally` is
   * load-bearing exactly as written: the expression is evaluated, the `finally`
   * runs `slot.end()` — which is what marks this engine operation quiescent and
   * lets the walk suspend — and the pending promise is returned. A helper that
   * PARKED would have to be `return`ed without `await` for that to still hold,
   * and then its own `claimSleep` would run after `slot.end()` and its park
   * would land on a slot already closed. Measured: `replayRun` never returns,
   * and `workflow-resume-equivalence.test.ts` times out rather than failing.
   */
  async function deadlineOutcome(
    key: string,
    token: string,
    occurrence: number,
    timeoutMs: number,
  ): Promise<DeadlineOutcome> {
    // A DEADLINE is journaled as its own sleep, sharing the hook's occurrence so
    // the two travel together. That is what makes the window immune to replay:
    // the wake time is decided the first time this wait is reached, where a
    // `Promise.race` against a fresh `ctx.sleep` would restart it on every
    // delivery and the window would never close.
    const deadlineKey = `hookTimeout!${token}#${occurrence}`;
    // The SAME snapshot arm `sleep` takes, and it applies for the same reason
    // rather than by analogy: a deadline is a row in the sleeps table, so
    // `readSleeps` already carries it and `overInSnapshot` is asking the same
    // monotonic question. What it does NOT skip is the `closeHook` below — the
    // window still has to be shut, and that answer decides the branch.
    if (!overInSnapshot(snapshot.get(deadlineKey), Date.now())) {
      const deadline = await journal.claimSleep(
        runId,
        deadlineKey,
        Date.now() + timeoutMs,
        undefined,
        // Not an ordinary sleep: a bare `wakeUp(runId)` cuts a SCHEDULE short and
        // must not also close an approval window. See `SleepRecord.kind`.
        "hookTimeout",
      );
      if (!(deadline.woken || Date.now() >= deadline.wakeAt)) {
        return { kind: "park", wakeAt: deadline.wakeAt };
      }
    }
    // Closed unanswered. The hook is CLOSED before the body continues, so a
    // signal arriving a moment later cannot make the next replay read a payload
    // and take the answered branch — see `HookRecord.closed`. `undefined` rather
    // than a throw: a window closing is an outcome a body branches on.
    //
    // The close is a COMPARE-AND-SET and its answer decides the branch. A signal
    // really can land between the deadline read above and this line, and closing
    // over it was the divergence `HookRecord.closed` exists to prevent arriving
    // by the other door: this walk would time out while every later replay read
    // `delivered: true` and answered.
    if (await journal.closeHook(runId, key)) return { kind: "closed" };
    // Refused, so the window was ANSWERED. Re-read it — `claimHook` is
    // idempotent on the key, so this is the same read the next replay makes,
    // which is exactly the point.
    const answered = await journal.claimHook(runId, key, token);
    return { kind: "answered", payload: answered.payload };
  }

  /**
   * The payload a wait resolves: checked against the schema, or handed on.
   *
   * The ONE place a payload becomes a value the body sees, which is why both
   * arms of {@link waitFor} route through it — an arm that cast directly would
   * be a hole nobody could see from the option's own doc. A refusal is recorded
   * AND thrown, the pair that stops a body's `catch` reporting `completed`.
   *
   * Nothing here touches the hook: by the time it runs the window has already
   * been claimed, and the module doc argues why validation must not un-claim it.
   */
  async function payloadOf<T>(
    token: string,
    payload: unknown,
    schema: StandardSchemaV1 | undefined,
  ): Promise<T> {
    if (schema === undefined) return payload as T;
    const check = await checkWorkflowValue(schema, payload);
    if (!check.ok) {
      const refusal = waitPayloadRefused(workflow, token, check.issues);
      refuse(refusal.message);
      throw refusal;
    }
    return check.value as T;
  }

  async function waitFor<T>(
    token: string,
    // Both bags: a wait may carry a deadline, a schema, or both — see
    // `WaitForSchemaOptions`, which exists so an unbounded validating wait does
    // not have to claim a `| undefined` it can never resolve.
    waitOptions?: WaitForOptions | WaitForSchemaOptions,
  ): Promise<T | undefined> {
    const noWait = refuseInsideStep("ctx.waitFor");
    if (noWait) throw noWait;
    // Keyed by the TOKEN the body reached — a name it already had, so unlike
    // `ctx.sleep` this needed no new argument.
    const occurrence = nextOccurrence(hookCounts, token);
    const slot = suspend.enter();
    const schema = waitOptions?.schema;
    try {
      const key = `hook!${token}#${occurrence}`;
      const record = await journal.claimHook(runId, key, token);
      // Is the record this wait's own? `claimHook` is idempotent on the KEY, so
      // what comes back on a replay was written by whichever wait reached that
      // key first — and its token is the one field in the answer that says which
      // one that was. An assertion about the key SCHEME rather than about the
      // body, and unreachable while the scheme names the token; see
      // `waitTokenDiverged` for what it caught when keys were positional.
      const mismatch = waitTokenDiverged(key, token, record.token);
      if (mismatch) {
        refuse(mismatch.message);
        throw mismatch;
      }
      // The FIRST payload, every replay. `claimHook` is idempotent on the key,
      // so a re-walk reads what was delivered rather than registering a second
      // wait.
      if (record.delivered) return await payloadOf<T>(token, record.payload, schema);
      // No deadline: nothing but a signal ends this, so the wait contributes no
      // wake time — `undefined` is what tells `earliestDeadline` to skip it.
      const timeoutMs = deadlineOf(waitOptions);
      if (timeoutMs === undefined) return slot.park(undefined);
      // AWAITED inside the slot, so the deadline's own journal write is held the
      // way every other engine operation is; the park below is what must stay in
      // this `try`. See `deadlineOutcome`.
      const outcome = await deadlineOutcome(key, token, occurrence, timeoutMs);
      if (outcome.kind === "park") return slot.park(outcome.wakeAt);
      // A window that closed carries no payload, so there is nothing to check —
      // see the module doc on why a timeout is not a validation failure.
      if (outcome.kind === "closed") return undefined;
      return await payloadOf<T>(token, outcome.payload, schema);
    } finally {
      slot.end();
    }
  }

  // Cast-free by construction: `sleep` takes a plain `string` label where
  // `WorkflowCtx.sleep` constrains it to `Literal<Label>`, and a wider parameter
  // is assignable to a narrower one. `waitFor`'s overloads resolve the same way.
  return { sleep, waitFor };
}
