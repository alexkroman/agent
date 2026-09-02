// Copyright 2026 the AAI authors. MIT license.
/**
 * The three non-deterministic reads a workflow body is allowed to make, because
 * this journals them.
 *
 * `ctx.now()`, `ctx.random()` and `ctx.uuid()` are sugar over a JOURNALED VALUE:
 * read the source once at the first reach, append the answer, and hand the
 * journaled answer back on every later walk. Nothing here is a new durability
 * mechanism — it is `ctx.step`'s own mechanism with the callback fixed and the
 * name reserved, which is precisely the shape authors were already writing by
 * hand. Two shipped templates had it: `transcription-workflow`'s `startClock` and
 * `call-audit`'s two `now` reads, each an exported one-line function reached
 * through a `ctx.step` and each carrying its own paragraph re-deriving the rule.
 *
 * **What it does NOT do is make the body deterministic by construction.**
 * Vercel's Workflow SDK runs a body inside a `node:vm` context with `Math.random`
 * seeded from `runId:workflowName:deploymentId`, `Date` pinned, and
 * `crypto.randomUUID` seeded — a stronger guarantee, and not one available here:
 * there is no VM in this engine, the guest bundle is ordinary compiled
 * TypeScript, and pinning `Date` would make `Date.now()` answer the run's START
 * time forever, which is a worse answer than the truth for a run that has slept a
 * day. So `guard-invariants` rule 30 stays the backstop for the un-sugared
 * spellings, and its remedy names these three.
 *
 * ## The three decisions, and why each went the way it did
 *
 * ### 1. Their own KEY SPACE, positional, per kind
 *
 * `now!0`, `random!0`, `uuid!0`. They do NOT share `ctx.step`'s `name#occurrence`
 * space, for the reason `ctx.sleep` does not: a call with no name argument has
 * nothing to key a map on, and sharing would let an author's own
 * `ctx.step("now")` alias a journaled clock read. `!` is not producible by
 * `name#occurrence`, which is what makes the two spaces disjoint by construction
 * rather than by convention — the same trick the waits' `sleep!`/`hook!` prefixes use, and they
 * are disjoint from THOSE too because a sleep lives in `claimSleep`'s records and
 * these live in `appendStep`'s entries.
 *
 * The counters are per KIND rather than one shared counter, so inserting a
 * `ctx.now()` at the top of a body shifts no `ctx.uuid()` beneath it. That does
 * not remove positional fragility, it narrows it: a body that reaches a different
 * NUMBER of reads of one kind still reads its predecessor's value, which is the
 * hazard `sdk/workflow-ctx.ts` already names for waits. What makes that
 * ACCEPTABLE here rather than merely inherited is the refusal below.
 *
 * **They participate in divergence detection, and deliberately never RAISE a
 * refusal.** Every reach is recorded through `DivergenceWatch.reach`, which is
 * not optional: the entries come back out of `readSteps`, so a determinism key
 * nobody marked as read would sit in the watch's unread set forever and the next
 * first-reached STEP would be refused as divergence on a perfectly healthy run.
 * What is discarded is the refusal `reach` may answer with. The precision of that
 * refusal rests on `claimAttempt` answering 1 — see
 * `workflow-replay-divergence.ts`, "two facts decide it" — and these calls take
 * no attempt (decision 2), so raising one would be the suspicious half of the
 * check without the half that makes it sound. Nothing is lost: a determinism read
 * has no side effect, so a diverged walk is refused at the next step it reaches
 * instead, one call later. A miss, never a false accusation, which is the
 * direction this whole check errs in.
 *
 * ### 2. No step ATTEMPT is leased
 *
 * `claimAttempt` is not called, and no `releaseAttempt` is owed. A charge is a
 * LEASE whose ceiling bounds ABANDONMENT — a worker that dies mid-body cannot
 * release, so the outstanding charge is the only evidence the attempt happened
 * (see "An attempt is a LEASE, not a tally" in `packages/aai-runtime/CLAUDE.md`).
 * These calls have no body to abandon: they read a global synchronously and
 * append once, so there is nothing a lease could be evidence of and nothing to
 * retry. Charging one would spend an author's `maxAttempts` budget — a budget
 * these calls do not even take an option for — on a call that cannot fail, and
 * would make a body that suspends after reading the clock burn an attempt per
 * delivery on the clock read.
 *
 * The entry records `attempts: 0`, which is the honest encoding of that: no
 * attempt was ever charged. A journal round trip can still fail, and it fails the
 * DELIVERY exactly as `appendStep` does for a step — the run's state is unknown
 * and the right move is a retry, not a verdict.
 *
 * ### 3. `random()` journals ONE FLOAT PER CALL
 *
 * Not a seeded sequence. A seed journaled once is fewer rows, and it makes every
 * draw's value depend on how many draws preceded it — so a body reaching a
 * different number of them before a loop silently re-draws the whole tail, and
 * the PRNG's exact algorithm becomes part of the durable contract (a run in
 * flight across a change of it diverges). Per-occurrence journaling is the same
 * mechanism as the other two, is correct in a loop with nothing further, and
 * costs one row per draw. A bulk draw belongs in a step, which is one row for
 * however many floats:
 * `ctx.step("jitter", () => Array.from({ length: n }, Math.random))`.
 *
 * ## Inside a step is REFUSED, exactly as a wait is
 *
 * The closure `ctx.step` is handed captures `ctx`, so
 * `ctx.step("s", () => ctx.now())` is one line away at every call site — and a
 * positional key makes it the same defect `workflow-replay-wait.ts` documents,
 * arriving by a third door. A settled step's body is not re-executed, so a read
 * inside one stops being reached the moment the step lands, and every later read
 * of that kind slides one place down the key space and answers with its
 * predecessor's value. For `uuid()` that is two logical identities collapsing
 * into one, silently, which is the shape of an idempotency-key bug that charges a
 * customer twice.
 *
 * Refusing costs nothing, because nothing correct is being refused: a step's
 * internals are not replayed, only its result, so a plain `Date.now()` inside a
 * step body is ALREADY durable and is what to write there. And a TYPE cannot
 * reach it, for `workflow-replay-wait.ts`'s reason — this would have to retype a
 * captured binding, and TypeScript has no effect system.
 *
 * @module
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { FatalError } from "@alexkroman1/aai/step-errors";
import type { JournalStore, StepEntry } from "./workflow-journal-types.ts";
import type { DivergenceWatch } from "./workflow-replay-divergence.ts";
import { currentRun } from "./workflow-run-context.ts";

/** The three reads, which is also the reserved half of the journal's key space. */
export type DeterminismKind = "now" | "random" | "uuid";

/** Every kind, so a caller can iterate them without restating the union. */
export const DETERMINISM_KINDS: readonly DeterminismKind[] = ["now", "random", "uuid"];

/**
 * The journal key one reach of `kind` reads and writes.
 *
 * Exported so a spec asserts the real key rather than a copy of this template —
 * the format is the durable contract, and a spec that spells it out separately is
 * a second copy of it to keep right.
 */
export function determinismKey(kind: DeterminismKind, occurrence: number): string {
  return `${kind}!${occurrence}`;
}

/**
 * Is `key` one of these rather than a step's?
 *
 * The `!` is the whole test — `name#occurrence` cannot produce one — and this
 * exists so a reader asking "why is there a `now!0` in this journal" finds the
 * answer from the key.
 */
export function isDeterminismKey(key: string): boolean {
  return DETERMINISM_KINDS.some((kind) => key.startsWith(`${kind}!`));
}

/**
 * The refusal for `method` called inside a step, or `undefined` at body level.
 *
 * The sibling of `waitInsideStep`, and it reads the same run context for the same
 * reason: that context is narrowed to the step for the whole of the body's
 * execution, helpers it awaits included, which is exactly where an accidental
 * `ctx.now()` hides. A separate function rather than a parameter on that one
 * because the DIAGNOSIS differs — nothing suspends here, and the remedy is to
 * read the global plainly rather than to move the call out.
 *
 * @internal
 */
export function determinismInsideStep(method: string): FatalError | undefined {
  const step = currentRun()?.step;
  if (step === undefined) return undefined;
  return new FatalError(
    `${method} was called inside ctx.step("${step.name}"), and a step body may not make one. ` +
      "These reads are keyed positionally, and a settled step's body is not re-executed — so " +
      "once the step lands this read stops being reached and every later read of its kind " +
      "slides one place down the key space and answers with its predecessor's value. There is " +
      "nothing to fix inside a step anyway: a step's internals are not replayed, only its " +
      "result, so read the clock, the random number or the uuid plainly inside " +
      `ctx.step("${step.name}", …) — or move ${method}() out into the workflow body, where its ` +
      "value is journaled.",
  );
}

/** What {@link createDeterminismReads} needs to answer one walk's reads. */
export type DeterminismOptions = {
  runId: string;
  journal: JournalStore;
  /**
   * The walk's journal snapshot, indexed by key — the same map `ctx.step` reads.
   *
   * Shared rather than copied so a determinism entry appended by this walk is
   * visible to whatever else consults it, and so there is exactly one answer to
   * "has this key settled".
   */
  settled: Map<string, StepEntry>;
  /** This walk's divergence watch. Every reach is recorded; no refusal is raised. */
  divergence: DivergenceWatch;
  /**
   * Record a refusal the ENGINE raised about this walk.
   *
   * A callback rather than a returned value because the refusal is also THROWN,
   * and `replayRun` holds the message so a body that catches broadly cannot turn
   * it into `completed` — the same contract a divergence and a wait-inside-a-step
   * have there.
   */
  refuse: (message: string) => void;
  /**
   * Hold the walk open for this read's journal write.
   *
   * A read is an ENGINE operation like a step, so a sibling wait that parks
   * while its `appendStep` is in flight must not suspend the delivery out from
   * under it — the read would go unjournaled, and if the process then died the
   * next delivery would produce a DIFFERENT value for the same key. Same reason
   * `ctx.step` takes one; see `workflow-replay-suspend.ts` on quiescence.
   */
  hold: <T>(op: () => Promise<T>) => Promise<T>;
};

/**
 * The three methods, bound to one walk.
 *
 * Split out of `replayRun` rather than inlined so that function keeps a diff the
 * size of one spread — it is the file two changes at a time land in, and it sits
 * near the 500-line cap.
 *
 * @internal
 */
export function createDeterminismReads(
  options: DeterminismOptions,
): Pick<WorkflowCtx, "now" | "random" | "uuid"> {
  const { runId, journal, settled, divergence, refuse, hold } = options;
  /** Reaches so far, per kind. A property of the WALK, like `ctx.step`'s. */
  const occurrences = new Map<DeterminismKind, number>();

  async function read<T>(kind: DeterminismKind, produce: () => T): Promise<T> {
    // BEFORE the counter advances, so a refused call leaves the key space
    // untouched and the failure names one cause rather than two.
    const inStep = determinismInsideStep(`ctx.${kind}`);
    if (inStep) {
      refuse(inStep.message);
      throw inStep;
    }
    // Synchronously, before any await: `Promise.all([ctx.now(), ctx.step(…)])`
    // evaluates its elements in source order, so an occurrence taken here is a
    // pure function of the body and one taken after an await would not be.
    const occurrence = occurrences.get(kind) ?? 0;
    occurrences.set(kind, occurrence + 1);
    const key = determinismKey(kind, occurrence);

    const answered = settled.get(key);
    // Recorded whether answered or not — see the module doc: an unrecorded reach
    // leaves this entry in the watch's unread set and gets the next STEP refused
    // on a healthy run. The refusal `reach` may answer with is discarded, which
    // is the other half of that paragraph.
    divergence.reach(key, kind, answered);
    if (answered !== undefined) return answered.output as T;

    // Read BEFORE `produce()` so the entry's span covers the read itself, which
    // is the same rule `attemptLoop` follows. It is microseconds here — these
    // have no body — and the point is that a reader can treat every entry's
    // `startedAt` the same way rather than having to know which kind it is.
    const startedAt = Date.now();
    const stored = await hold(() =>
      journal.appendStep(runId, {
        key,
        name: kind,
        status: "ok",
        output: produce(),
        // No attempt was charged. Decision 2 in the module doc.
        attempts: 0,
        startedAt,
        finishedAt: Date.now(),
      }),
    );
    settled.set(key, stored);
    // The STORE's value, never this walk's own: `appendStep` is idempotent on the
    // key, so a redelivery that raced this one has already decided the answer and
    // both walks must return the same thing or they diverge from here on.
    return stored.output as T;
  }

  return {
    now: () => read("now", () => Date.now()),
    random: () => read("random", () => Math.random()),
    uuid: () => read("uuid", () => crypto.randomUUID()),
  };
}
