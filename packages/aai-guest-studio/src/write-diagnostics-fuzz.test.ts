// Copyright 2026 the AAI authors. MIT license.
/**
 * Randomized interleavings of parallel writes through the ONE shared
 * post-write checker (`createPostWriteDiagnostics`): writes landing while a
 * type check runs, checks finishing in an order `fc.scheduler` picks, and the
 * checker throwing.
 *
 * The tree is a version counter; a write bumps it and then asks for its
 * diagnostics, as the coding tools' `afterWrite` seam does. The fake compiler
 * reports the version it STARTED on, which is what lets a verdict be traced
 * back to the tree it read.
 *
 * The invariants:
 *
 * - **A verdict vouches for the write that asked.** Every diagnostics block a
 *   write receives comes from a check that started AFTER that write landed —
 *   the module's whole reason for the coalescing runner's trailing run.
 * - **Checks never overlap** (one compiler at a time over one tree).
 * - **No check is redundant**: each starts on a strictly newer tree than the
 *   one before it, so N writes during a check share ONE follow-up rather than
 *   queueing N (a second follow-up would re-read the same tree).
 * - **A broken checker never fails a write** — it degrades to no diagnostics.
 */

import { sleep } from "@alexkroman1/aai/internal";
import fc from "fast-check";
import { expect, test } from "vitest";
import { createPostWriteDiagnostics, type TypecheckResult } from "./write-diagnostics.ts";

/** One event: a write of a script (or of a non-script, which is not checked). */
type Op = { kind: "write"; script: boolean } | { kind: "advance" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("write" as const),
      script: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, fc.constant(false)),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: "advance" } as const) },
);

/** States the walk must reach — floors asserted after the property. */
const reached = { coalescedWrites: 0, trailingChecks: 0, checkerThrew: 0 };

/** What is wrong with the diagnostics a write of version `wrote` received, if anything. */
function judgeVerdict(block: string | undefined, script: boolean, wrote: number): string | null {
  if (!script) return block === undefined ? null : "a non-script write got diagnostics";
  if (block === undefined) return null; // clean, or the checker failed
  const seen = Number(/@v(\d+)/.exec(block)?.[1]);
  return seen >= wrote ? null : `write v${wrote} was answered by a check of v${seen}`;
}

/** A fake compiler over a version-counter tree, reporting the version it started on. */
function scheduledCompiler(
  s: fc.Scheduler,
  throws: readonly boolean[],
  tree: { version: number },
  problems: string[],
) {
  const state = { running: 0, checks: 0, lastStart: -1 };
  const typecheck = async (): Promise<TypecheckResult> => {
    const started = tree.version;
    const index = state.checks++;
    state.running += 1;
    if (state.running > 1) problems.push("two type checks overlapped");
    if (started <= state.lastStart) problems.push(`check #${index} re-read v${started}`);
    state.lastStart = started;
    try {
      await s.schedule(Promise.resolve(), `check #${index} of v${started}`);
      if (throws[index % throws.length] === true) {
        reached.checkerThrew += 1;
        throw new Error("tsc crashed");
      }
      return { ok: false, output: `error TS2322 @v${started}` };
    } finally {
      state.running -= 1;
    }
  };
  return { typecheck, state };
}

/** One write landing, then asking for its diagnostics. */
function write(
  diagnostics: (rel: string) => Promise<string | undefined>,
  tree: { version: number },
  script: boolean,
  problems: string[],
): Promise<void> {
  // A non-script write changes nothing a type check reads.
  if (script) tree.version += 1;
  const wrote = tree.version;
  return diagnostics(script ? `agent-${wrote}.ts` : `notes-${wrote}.md`).then(
    (block) => {
      const problem = judgeVerdict(block, script, wrote);
      if (problem) problems.push(problem);
    },
    (err: unknown) => {
      problems.push(`a write's diagnostics REJECTED: ${String(err)}`);
    },
  );
}

async function runWrites(
  s: fc.Scheduler,
  ops: readonly Op[],
  throws: readonly boolean[],
): Promise<string[]> {
  const problems: string[] = [];
  const tree = { version: 0 };
  const { typecheck, state } = scheduledCompiler(s, throws, tree, problems);
  const diagnostics = createPostWriteDiagnostics(typecheck);

  const pending: Promise<void>[] = [];
  for (const op of ops) {
    if (op.kind === "write") {
      if (state.running > 0 && op.script) reached.coalescedWrites += 1;
      pending.push(write(diagnostics, tree, op.script, problems));
    } else if (s.count() > 0) {
      await s.waitNext(1);
    }
    await sleep(0);
  }
  // `waitFor` releases tasks as the writes need them — a trailing check is
  // scheduled only once the one before it settles.
  await s.waitFor(Promise.all(pending));
  const scriptWrites = ops.filter((op) => op.kind === "write" && op.script).length;
  if (state.checks > 0 && state.checks < scriptWrites) reached.trailingChecks += 1;
  return problems;
}

test("parallel writes share one checker: verdicts vouch for their write, no overlap, no backlog", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(opArb, { minLength: 1, maxLength: 24 }),
      fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }).map((xs) => [...xs, false]),
      async (s, ops, throws) => {
        expect(await runWrites(s, ops, throws)).toEqual([]);
      },
    ),
    { numRuns: 100 },
  );

  // Coverage floors, each under the minimum observed by
  // `pnpm floors:sample --runs 20` (range beside each).
  expect(reached.coalescedWrites, "no write ever landed during a check").toBeGreaterThan(60); // Measured over 20 runs: 136-193.
  expect(reached.trailingChecks, "no burst ever coalesced").toBeGreaterThan(12); // Measured over 20 runs: 28-46.
  expect(reached.checkerThrew, "the checker never threw").toBeGreaterThan(35); // Measured over 20 runs: 79-112.
});
