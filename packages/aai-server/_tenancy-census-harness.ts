// Copyright 2026 the AAI authors. MIT license.
/**
 * Did a generated program actually put two tenants' rows in each other's way?
 *
 * The load-bearing half of the tenancy property is not the property. It is this:
 * a corpus in which the two slugs never named the same row satisfies "no read
 * for A returns a row written under B" trivially and forever, at the same green
 * count and the same coverage percentage. So every counter here is a COLLISION
 * state, and `check:property-floors`'s whole argument is why a floor on
 * something bland — ops issued, runs created — would be worse than none.
 *
 * Each counter is classified against the state the tenants were in BEFORE the op
 * ran, read out of the REFERENCE world rather than the arm under test, so a
 * leaking implementation cannot talk its own coverage up.
 *
 * Split from `_tenancy-ops-harness.ts` at the seam that file already had — the
 * grammar says what a program IS, this says what one REACHED — and re-exported
 * from there so no import site has to know.
 */

// TYPE-ONLY, so this file and the one that re-exports it are not a runtime
// cycle. `NEIGHBOUR` lives here rather than beside `SLUGS` for the same reason:
// the census is its only consumer.
import type { Answer, Op, Slug, TenantDump } from "./_tenancy-ops-harness.ts";

/** The neighbour, for the census questions that are all "does the other one hold this?". */
export const NEIGHBOUR: Record<Slug, Slug> = {
  "tenancy-alpha": "tenancy-beta",
  "tenancy-beta": "tenancy-alpha",
};

/** Mirrors `platform-workflow-journal.ts`'s `TERMINAL`. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** States a run has to have REACHED, or the property is vacuous. */
export type Census = {
  /** Ops naming a run id BOTH tenants hold. */
  sharedRuns: number;
  /** Reads for a run id only the NEIGHBOUR holds — the classic leak read. */
  foreignRunReads: number;
  /** `appendStep` on a `(run_id, key)` the neighbour already has a step at. */
  sharedStepKeys: number;
  /** `claimAttempt` on a `(run_id, key)` the neighbour already counts. */
  sharedAttemptKeys: number;
  /** `wakeSleeps` for a run the neighbour has an unwoken sleep on. */
  foreignSleepWakes: number;
  /** `deliverHook` for a token only the neighbour holds deliverably. */
  foreignTokenDeliveries: number;
  /**
   * A `setStatus` that WILL move a run of this tenant to a terminal status while
   * the neighbour holds a hook on the same run id.
   *
   * The state the whole property exists for. `setStatus`'s `released` CTE
   * deletes from `workflow_hooks` joined on `run_id` from `moved`, and its
   * `h.slug = $1` is a SEPARATE predicate — drop it and the statement STILL
   * carries `slug = $1`, on the `moved` arm, so a per-statement grep for a
   * tenancy predicate goes on passing. Only a run that reaches this state can
   * see it. Verified: with that one predicate deleted the property reddens and
   * shrinks to a program whose 29th op is `setStatus` on `tenancy-alpha`,
   * naming `tenancy-beta` as the tenant whose hook row went missing.
   *
   * "WILL move" is part of it: the compare-and-set has to pass, or `moved` is
   * empty, nothing is released, and the state was not really entered.
   */
  terminalWithForeignHook: number;
  /** An upload write for an id only the neighbour holds. */
  foreignUploadWrites: number;
  /** `discardSession` for a session the neighbour also has rows under. */
  foreignSessionDiscards: number;
  /** Refusals answered — a caller-chosen id being refused is itself observable. */
  refusals: number;
};

export const emptyCensus = (): Census => ({
  sharedRuns: 0,
  foreignRunReads: 0,
  sharedStepKeys: 0,
  sharedAttemptKeys: 0,
  foreignSleepWakes: 0,
  foreignTokenDeliveries: 0,
  terminalWithForeignHook: 0,
  foreignUploadWrites: 0,
  foreignSessionDiscards: 0,
  refusals: 0,
});

/** Which counters this op's own kind can move, one predicate each. */
type Rule = { of: keyof Census; when: (mine: TenantDump, theirs: TenantDump, op: Op) => boolean };

/**
 * One rule per op kind, as data rather than as a switch.
 *
 * The switch this replaces measured 29 on Biome's cognitive-complexity scale
 * against a limit of 15 — and a suppression comment is not available, being a
 * counted escape hatch. As data each predicate is also readable on its own,
 * which is what a floor's failure message has to be traceable to.
 */
const RULES: Partial<Record<Op["t"], Rule>> = {
  appendStep: {
    of: "sharedStepKeys",
    when: (_mine, theirs, op) =>
      "key" in op && theirs.steps.some((s) => s.runId === op.runId && s.key === op.key),
  },
  claimAttempt: {
    of: "sharedAttemptKeys",
    when: (_mine, theirs, op) =>
      "key" in op && theirs.attempts.some((a) => a.runId === op.runId && a.key === op.key),
  },
  wakeSleeps: {
    of: "foreignSleepWakes",
    when: (_mine, theirs, op) =>
      "runId" in op && theirs.sleeps.some((s) => s.runId === op.runId && !s.woken),
  },
  deliverHook: {
    of: "foreignTokenDeliveries",
    when: (mine, theirs, op) =>
      op.t === "deliverHook" && !live(mine, op.token) && live(theirs, op.token),
  },
  setStatus: {
    of: "terminalWithForeignHook",
    when: (mine, theirs, op) => releases(mine, theirs, op),
  },
  updateUpload: { of: "foreignUploadWrites", when: foreignUpload },
  finishUpload: { of: "foreignUploadWrites", when: foreignUpload },
  discardSession: {
    of: "foreignSessionDiscards",
    when: (_mine, theirs, op) =>
      "sessionId" in op &&
      (theirs.slots.some((s) => s.sessionId === op.sessionId) ||
        theirs.events.some((e) => e.sessionId === op.sessionId)),
  },
};

/** A window a delivery could still be taken through. */
const live = (dump: TenantDump, token: string): boolean =>
  dump.hooks.some((hook) => hook.token === token && !hook.delivered && !hook.closed);

/** Would this `setStatus` really run the release CTE over a colliding run id? */
function releases(mine: TenantDump, theirs: TenantDump, op: Op): boolean {
  if (op.t !== "setStatus" || !TERMINAL.has(op.status)) return false;
  const run = mine.runs.find((r) => r.runId === op.runId);
  if (!run || (op.expect && !op.expect.includes(run.status))) return false;
  return theirs.hooks.some((hook) => hook.runId === op.runId);
}

/** An upload write aimed at an id only the neighbour holds. */
function foreignUpload(mine: TenantDump, theirs: TenantDump, op: Op): boolean {
  if (!("id" in op)) return false;
  return !mine.uploads.some((u) => u.id === op.id) && theirs.uploads.some((u) => u.id === op.id);
}

/** Classify one op against the state the tenants were in BEFORE it ran. */
export function noteOp(seen: Census, dumps: Record<Slug, TenantDump>, op: Op): void {
  const mine = dumps[op.slug];
  const theirs = dumps[NEIGHBOUR[op.slug]];
  if ("runId" in op) {
    const here = mine.runs.some((r) => r.runId === op.runId);
    const there = theirs.runs.some((r) => r.runId === op.runId);
    if (here && there) seen.sharedRuns++;
    if (!here && there && (op.t === "getRun" || op.t === "readSteps")) seen.foreignRunReads++;
  }
  const rule = RULES[op.t];
  if (rule?.when(mine, theirs, op)) seen[rule.of]++;
}

/** A refusal is observable, so it is counted too. */
export function noteAnswer(seen: Census, answer: Answer): void {
  if ("refused" in answer) seen.refusals++;
}
