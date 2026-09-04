// Copyright 2026 the AAI authors. MIT license.
/**
 * The sync decision's DEFINING property, over walks nobody wrote by hand.
 *
 * > Replaying the frames this decision pushed must equal the projection.
 *
 * The client holds whatever the last `push: true` frame said — a frame is the
 * WHOLE projection, so replaying them is taking the last one — and every skip is
 * a claim that it does not need another. So the invariant has one interesting
 * half and one obvious one: `unchanged` must mean the client already holds the
 * current projection, and the record `recordPush` writes must name a frame the
 * client was really SENT. `_state-sync.test.ts` next door states each decision on
 * a hand-chosen value; this states the relation between them over a generated
 * sequence.
 *
 * ## The four transitions, in this module's own vocabulary
 *
 * A walk is a sequence of these, and the reachable defect needs all four in
 * order:
 *
 * | # | Transition | What the module does |
 * | --- | --- | --- |
 * | 1 | **change** | the serialized frame differs from `session.lastPush()` → `{ push: true, state }`, and `recordPush(serialized)` |
 * | 2 | **over-cap** | `Buffer.byteLength(serialized) > MAX_CLIENT_EVENT_PAYLOAD_BYTES` (65,536) → `{ push: false, reason: "too-large" }`, and **no `recordPush`** |
 * | 3 | **revert** | the projection returns to exactly the string `lastPush()` holds → `{ push: false, reason: "unchanged" }` |
 * | 4 | **force** | `options.force` skips the `serialized === session.lastPush()` comparison — and NOTHING else, the cap included → `{ push: true }` on an otherwise unchanged frame |
 *
 * `change → over-cap → revert → force` is the sequence, and the reason it is the
 * one that matters is the ORDER of the two guards: the unchanged comparison runs
 * BEFORE the cap check. So a record written on the over-cap path would be
 * consulted by the very next call and answered `unchanged` — a skip asserting
 * the client holds a frame that was refused for being too big to send, with
 * `force` the only thing that could ever repaint it. No hand-written case walks
 * that far, which is the whole argument for generating the walk. The A/B is in
 * the module doc's terms: adding `session.recordPush(serialized)` above the
 * `too-large` return reddens this property at two ops.
 *
 * ## The model
 *
 * `client` is the last frame pushed and `pushed` the cells that produced it,
 * which is what makes **revert** representable at all — the walk has to be able
 * to ask for the value the client last saw, and a random draw from a pool
 * effectively never lands on it. That is a state-dependent INTENT: with nothing
 * pushed yet there is no value to revert to and the move no-ops rather than
 * inventing one.
 *
 * The expected decision is written against `client` rather than against the
 * record, which is the point of a model: the implementation compares serialized
 * frames against what it WROTE DOWN, and the two agreeing is under test.
 */

import { sessionSlot } from "@alexkroman1/aai";
import { MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "@alexkroman1/aai/internal";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createStateSync, type StateSync, type StateSyncSession } from "./_state-sync.ts";

const CAP = MAX_CLIENT_EVENT_PAYLOAD_BYTES;

/** The slots a generated world may hold. Two, so the MERGE path is walked too. */
const SLOT_KEYS = ["cart", "flags"] as const;

/**
 * One slot's stored value. `fill` is the knob that reaches the cap, `tag` the one
 * that makes two small frames differ, `boom` the author bug.
 */
type Cell = { tag: string; fill: number; boom: boolean };

/**
 * The small values a `set` may write — a SHORT pool consumed by index, so two
 * writes can land on the same frame and an ordinary `unchanged` is reachable
 * without the explicit revert.
 */
const SMALL: readonly Cell[] = [
  { tag: "a", fill: 0, boom: false },
  { tag: "b", fill: 0, boom: false },
  { tag: "a", fill: 6, boom: false },
];

/** A value whose frame cannot fit: the blob alone is the whole budget. */
const HUGE: Cell = { tag: "a", fill: CAP, boom: false };

/** A projection that throws — the author's mistake, reported not raised. */
const BOOM: Cell = { tag: "a", fill: 0, boom: true };

/** What one op does to the values before the decision is asked for. */
type Move =
  | { k: "set"; slot: number; cell: number }
  | { k: "bloat"; slot: number }
  | { k: "break"; slot: number }
  | { k: "revert" }
  | { k: "hold" };

/** One op: a value change, then one call of the decision. */
type Op = { move: Move; force: boolean };

const moveArb: fc.Arbitrary<Move> = fc.oneof(
  {
    weight: 38,
    arbitrary: fc.record({
      k: fc.constant("set" as const),
      slot: fc.nat({ max: SLOT_KEYS.length - 1 }),
      cell: fc.nat({ max: SMALL.length - 1 }),
    }),
  },
  {
    weight: 22,
    arbitrary: fc.record({
      k: fc.constant("bloat" as const),
      slot: fc.nat({ max: SLOT_KEYS.length - 1 }),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      k: fc.constant("break" as const),
      slot: fc.nat({ max: SLOT_KEYS.length - 1 }),
    }),
  },
  { weight: 22, arbitrary: fc.record({ k: fc.constant("revert" as const) }) },
  { weight: 12, arbitrary: fc.record({ k: fc.constant("hold" as const) }) },
);

const opArb: fc.Arbitrary<Op> = fc.record({
  move: moveArb,
  // A forced call is the resume case, so it is the minority — but not rare, or
  // the fourth transition below is never reached.
  force: fc.oneof(
    { weight: 3, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
});

/**
 * The decisions this module can reach, as the property names them: `push` plus
 * the three skip reasons.
 */
type Decision = "push" | "unchanged" | "too-large" | "failed";

/**
 * States the generated walks must have REACHED. Without them the equality
 * assertion is satisfied by walks that never over-capped, never reverted, and
 * never forced — i.e. by walks that cannot see the defect the property was
 * written for.
 *
 * Floors sit under the OBSERVED MINIMUM over 20 runs, with the range beside
 * each; what a walk reaches is correlated within a run rather than independent
 * per op, so these distributions have long left tails.
 */
const reached = {
  /**
   * An over-capped frame followed by a revert the decision answered `unchanged`
   * — transitions 2 → 3.
   *
   * The plain over-cap count was measured too (656-780 over the same 20 runs)
   * and dropped rather than floored: this counter cannot rise without it, so a
   * floor on it asserts nothing this one does not already guarantee, and a
   * redundant floor is the compliance floor `check:property-floors` exists to
   * discourage.
   */
  revertAfterCap: 0,
  /** The whole sequence: change → over-cap → revert → force. */
  changeCapRevertForce: 0,
  /** Projections that threw, so the failure path is compared too. */
  failures: 0,
};

/** A session as the store presents one: the values, plus the last-sent record. */
function fakeSession(): StateSyncSession & { set(key: string, value: unknown): void } {
  let lastPush: string | undefined;
  const held = new Map<string, unknown>();
  return {
    read: (key) => held.get(key),
    lastPush: () => lastPush,
    recordPush: (json) => {
      lastPush = json;
    },
    set: (key, value) => held.set(key, value),
  };
}

/**
 * The frame the projections MUST produce, computed without the module — the same
 * merge order, spelled out.
 *
 * `"throws"` stands for a world where some projection cannot run at all; a
 * single-slot world takes the same shape because each projection here returns an
 * object, so one arm covers both the lone-projection and the merged case.
 */
function frameOf(keys: readonly string[], cells: readonly Cell[]): string {
  const merged: Record<string, unknown> = {};
  for (const [index, key] of keys.entries()) {
    const cell = cells[index] as Cell;
    if (cell.boom) return "throws";
    merged[`${key}_tag`] = cell.tag;
    merged[`${key}_blob`] = "x".repeat(cell.fill);
  }
  return JSON.stringify(merged);
}

/**
 * A frame as a counterexample should print it. An over-cap frame is 65 kB, and a
 * shrunk report nobody can read is a shrunk report nobody uses.
 */
function tag(frame: string | undefined): string {
  if (frame === undefined) return "<none>";
  return frame.length <= 48 ? frame : `${frame.slice(0, 24)}…(${frame.length}c)`;
}

/** One trace entry: the decision, the frame sent, and the record left behind. */
type Entry = { step: number; decision: Decision; frame: string; record: string };

/** The generated world: the slot values, and the session holding them. */
type World = {
  keys: readonly string[];
  cells: Cell[];
  session: ReturnType<typeof fakeSession>;
};

/** The decision under test, built over one world's slots. */
function syncFor(keys: readonly string[]): StateSync {
  const slots = keys.map((key) => sessionSlot(key, () => SMALL[0] as Cell));
  return createStateSync(
    slots.map((slot) =>
      slot.projection((cell) => {
        if (cell.boom) throw new Error(`the ${slot.key} projection failed`);
        return { [`${slot.key}_tag`]: cell.tag, [`${slot.key}_blob`]: "x".repeat(cell.fill) };
      }),
    ),
  );
}

function write(world: World, slot: number, cell: Cell): void {
  // CLAMPED rather than filtered: a one-slot world still has to accept a move
  // naming slot 1, so every generated value maps to a legal one.
  const index = Math.min(slot, world.keys.length - 1);
  world.cells[index] = cell;
  world.session.set(world.keys[index] as string, cell);
}

/**
 * Apply one move to the values.
 *
 * `revert` is the state-dependent one: it goes back to exactly the values the
 * client was last shown, so with nothing pushed yet there is no such value and
 * the move NO-OPS rather than driving the world through a transition it cannot
 * really make.
 */
function applyMove(world: World, move: Move, pushed: readonly Cell[] | undefined): void {
  if (move.k === "set") write(world, move.slot, SMALL[move.cell] as Cell);
  else if (move.k === "bloat") write(world, move.slot, HUGE);
  else if (move.k === "break") write(world, move.slot, BOOM);
  else if (move.k === "revert" && pushed !== undefined) {
    for (const [index, cell] of pushed.entries()) write(world, index, cell);
  }
}

/**
 * The SPEC, in the order the module applies its guards — and written against the
 * CLIENT's own view, never against the record the module wrote down. The two
 * agreeing is what is under test.
 */
function expectedDecision(want: string, client: string | undefined, force: boolean): Decision {
  if (want === "throws") return "failed";
  if (!force && want === client) return "unchanged";
  if (Buffer.byteLength(want) > CAP) return "too-large";
  return "push";
}

/**
 * The `change → over-cap → revert → force` subsequence matcher, and the two
 * counters on it. Returns the new phase; a plain push is always a fresh
 * `change`, so it restarts the match rather than extending it, and anything
 * else leaves the phase alone.
 */
function advancePhase(phase: number, decision: Decision, force: boolean): number {
  if (decision === "push" && !force) return 1;
  if (phase >= 1 && decision === "too-large") return 2;
  if (phase === 2 && decision === "unchanged") {
    reached.revertAfterCap++;
    return 3;
  }
  if (phase === 3 && decision === "push" && force) {
    reached.changeCapRevertForce++;
    return 1;
  }
  return phase;
}

/**
 * Walk one world, returning the OBSERVED and EXPECTED traces.
 *
 * Compared whole rather than op by op so a divergence prints both walks side by
 * side; a chain of `expect`s per op prints only the first field to differ, which
 * is rarely the informative one.
 */
function walk(slotCount: number, ops: readonly Op[]): { observed: Entry[]; expected: Entry[] } {
  const keys = SLOT_KEYS.slice(0, slotCount);
  const sync = syncFor(keys);
  const world: World = {
    keys,
    cells: keys.map(() => SMALL[0] as Cell),
    session: fakeSession(),
  };
  for (const [index, key] of keys.entries()) world.session.set(key, world.cells[index]);

  /** The frame the client holds, and the cells that produced it. */
  let client: string | undefined;
  let pushed: Cell[] | undefined;
  /** How far into `change → over-cap → revert → force` this walk has got. */
  let phase = 0;

  const observed: Entry[] = [];
  const expected: Entry[] = [];

  for (const [step, op] of ops.entries()) {
    applyMove(world, op.move, pushed);
    const want = frameOf(keys, world.cells);
    const decision = expectedDecision(want, client, op.force);
    const result = sync(world.session, op.force ? { force: true } : undefined);

    if (decision === "push") {
      client = want;
      pushed = world.cells.map((cell) => ({ ...cell }));
    }
    expected.push({
      step,
      decision,
      frame: tag(decision === "push" ? want : undefined),
      // The record must name a frame the client was really sent — the claim the
      // `unchanged` skip rests on.
      record: tag(client),
    });
    observed.push({
      step,
      decision: result.push ? "push" : result.reason,
      frame: tag(result.push ? JSON.stringify(result.state) : undefined),
      record: tag(world.session.lastPush()),
    });

    if (decision === "failed") reached.failures++;
    phase = advancePhase(phase, decision, op.force);
  }

  return { observed, expected };
}

describe("the sync decision over a generated walk", () => {
  test("replaying the pushed frames equals the projection, and the record names one of them", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: SLOT_KEYS.length }),
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        (slotCount, ops) => {
          const { observed, expected } = walk(slotCount, ops);
          expect(observed, "the decision diverged from the model").toEqual(expected);
        },
      ),
      { numRuns: 400 },
    );

    // Ranges over 20 runs, each floor set under the OBSERVED MINIMUM.
    expect(reached.failures, "no projection ever threw").toBeGreaterThan(100); // 170-314
    // The two that matter, and the reason the walk is generated rather than
    // listed: a property that never reaches `change → over-cap → revert` proves
    // nothing about a record written on the over-cap path, and one that never
    // reaches the `force` behind it cannot see that force is the only repaint
    // left.
    expect(reached.revertAfterCap, "no revert followed an over-capped frame").toBeGreaterThan(40); // 75-112
    expect(
      reached.changeCapRevertForce,
      "no walk reached change → over-cap → revert → force",
    ).toBeGreaterThan(5); // 10-27
  }, 30_000);
});
