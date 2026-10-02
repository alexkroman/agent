// Copyright 2026 the AAI authors. MIT license.
/**
 * The interleavings this repo has FOUND, replayed deterministically.
 *
 * `workflow/concurrent-delivery.test.ts` draws an ordering at random, checks
 * five laws over it, and — when one fires — shrinks to the smallest ordering
 * that still breaks it, prints it, and then throws it away. Every finding made
 * that way survives in this repo as prose: the attempt-lease defect is three
 * paragraphs of that file's module doc, complete with the shrunk body and the
 * delivery count, and is a regression for nothing. `workflow/_laws-harness.ts`
 * makes the argument from the other side without drawing the conclusion — its
 * doc explains that a law answers a LIST because *"under an interleaving the
 * informative violation is rarely the first one"*, which is a statement about
 * reading a counterexample.
 *
 * `fc.schedulerFor(ordering)` is the other half of `fc.scheduler`: it replays a
 * given ordering instead of drawing one. So a counterexample can be kept, and
 * `workflow-interleavings/` is where they are — one file each, carrying the
 * program, the delivery burst and the ordering, none of it written by hand.
 *
 * ## Two arms per interleaving, and the second one is the point
 *
 * A frozen ordering that only ever passes is a case nobody can tell is still
 * checking anything, which is the shape of failure this repo keeps paying for.
 * So each file names the GUARD whose removal its ordering catches, and every
 * scenario runs twice:
 *
 * - against the real store, where the laws hold — this is the regression;
 * - against the same store with that one guard taken out
 *   (`workflow/_defective-journal.ts`), where the named law fires — this is the
 *   proof the regression can fail.
 *
 * The two arms live in each scenario's co-located spec
 * (`interleavings/<name>.test.ts`, over the shared replay in
 * `_interleaving-test-utils.ts`); this file keeps the corpus itself. A scenario
 * file with no spec of its own fails `check:module-tests`, so a new one cannot
 * be enumerated here and replayed nowhere.
 *
 * Together they also close a gap the property could not: until this file, none
 * of the five laws had ever been demonstrated to fire on anything a suite kept,
 * so a law that had quietly become unfalsifiable would have looked exactly like
 * a law that holds.
 *
 * ## The corpus is FLOORED
 *
 * A directory of frozen scenarios is a corpus, and a corpus that stops being
 * enumerated prints the same green as one that holds — `check-escape-hatches`
 * and `guard-invariants` both carry the same floor for the same reason. So the
 * count is asserted and each defect must be covered by at least one file: a
 * defect nothing catches is a defect the suite believes it is testing.
 *
 * ## One of these is a bug that SHIPPED
 *
 * `colliding-start.ts`. The platform store accepted a second `createRun` on a
 * taken id, so two racing starts both believed they had won and the loser's
 * input was discarded — for every deployed agent — and nothing at this tier
 * could see it, the conformance suite's platform arm being a fake over the
 * memory reference that refuses. Only a Postgres scenario run could. Modelling
 * the shipped behaviour as a decorator is what moves that claim down to a
 * millisecond of unit tier, and it is the argument for the whole directory: a
 * store-level defect is expressible here whatever backend really has it.
 *
 * ## What is deliberately NOT here
 *
 * The attempt-lease counterexample itself. Reproducing it needs `claimAttempt`
 * back as a durable TALLY with tries counted durably too, which is not one
 * guard removed but the old design restored — `workflow/replay/step.ts`'s "An
 * attempt is a LEASE" is a change to the engine, not to the store, and a
 * decorator cannot express it. The shapes that found it (`flaky` under three
 * deliveries) are in the generated grammar and measured there; that test's doc
 * records the 45-scenario cost of hitting it. This file freezes what a STORE
 * decorator can express, and says so rather than implying the whole history is
 * covered.
 */

import { describe, expect, test } from "vitest";
import type { JournalDefect } from "./_defective-journal.ts";
import { collidingStart } from "./interleavings/colliding-start.ts";
import { doubleTerminalMove } from "./interleavings/double-terminal-move.ts";
import { hookCloseRace } from "./interleavings/hook-close-race.ts";
import type { Interleaving } from "./interleavings/interleaving.ts";
import { overlappingStepAppend } from "./interleavings/overlapping-step-append.ts";

/**
 * Every kept interleaving.
 *
 * Enumerated by IMPORT rather than by a directory glob, so a file nothing
 * imports is a knip finding and a typo is a compile error — the two ways a
 * glob-driven corpus silently shrinks.
 */
const KEPT: readonly Interleaving[] = [
  hookCloseRace,
  overlappingStepAppend,
  doubleTerminalMove,
  collidingStart,
];

/** Every defect a kept interleaving is expected to catch. */
const DEFECTS: readonly JournalDefect[] = [
  "unconditionalClose",
  "overwritingAppend",
  "unguardedStatus",
  "silentDuplicateCreate",
];

describe("the corpus", () => {
  test("is enumerated, named uniquely, and covers every defect", () => {
    // A floor rather than an exact count: the point is that the corpus has not
    // silently emptied, and a new interleaving should not have to edit a number.
    expect(KEPT.length, "the frozen interleaving corpus has shrunk").toBeGreaterThanOrEqual(4);
    expect(new Set(KEPT.map((kept) => kept.name)).size).toBe(KEPT.length);
    for (const defect of DEFECTS) {
      expect(
        KEPT.some((kept) => kept.catches.defect === defect),
        `no frozen interleaving catches ${defect}`,
      ).toBe(true);
    }
  });
});
