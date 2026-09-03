// Copyright 2026 the AAI authors. MIT license.
/**
 * The one property that lets a step body's I/O be cancelled.
 *
 * The engine hands a step body no `AbortSignal`, and cannot start doing so
 * without moving a published signature (`WorkflowCtx.step`'s callback). So the
 * walk's signal rides the RUN CONTEXT instead, which is what lets `step-fetch.ts`
 * combine it into every outbound request without a body threading one down
 * through its own helpers — the same argument `report()` rests on, in
 * `workflow-run-context.ts`'s module doc.
 *
 * Its own file rather than a `describe` in `workflow-replay.test.ts`, which is at
 * the 700-line test cap. Asserted HERE as well as at the reader
 * (`step-fetch.test.ts`) because the reader's spec builds the context by hand and
 * would stay green if the engine stopped filling this in — which is the whole
 * failure: before this, a cancelled run went on uploading a recording nobody was
 * waiting for until the process died.
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";
import { currentRun } from "./workflow-run-context.ts";

/** A running run in a fresh memory journal, ready to replay. */
async function seed(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: "wrun_1",
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return journal;
}

/** Read `currentRun()?.step?.signal` from inside a step, and answer with it. */
async function signalSeenInStep(
  journal: JournalStore,
  signal?: AbortSignal,
): Promise<AbortSignal | undefined> {
  let seen: AbortSignal | undefined;
  const run = async (_input: Record<string, unknown>, ctx: WorkflowCtx) =>
    await ctx.step("look", () => {
      seen = currentRun()?.step?.signal;
      return "done";
    });
  await replayRun({
    runId: "wrun_1",
    workflow: "digest",
    input: {},
    journal,
    run,
    // Passed straight through rather than conditionally spread: `ReplayOptions`
    // declares `signal?: AbortSignal | undefined`, so an absent one is legal
    // here and `guard-invariants` rules 2 and 22 have nothing to catch.
    signal,
  });
  return seen;
}

describe("a step body's I/O can be cancelled", () => {
  test("the WALK's signal is in scope for the whole of a step body", async () => {
    const walk = new AbortController();
    expect(await signalSeenInStep(await seed(), walk.signal)).toBe(walk.signal);
  });

  test("a walk with no signal leaves the step's undefined rather than inventing one", async () => {
    // A step called from a spec, and `aai dev`'s in-process delivery before a
    // cancel controller exists, both land here. An invented signal would be one
    // nothing ever aborts, which reads as working and is worse than none.
    expect(await signalSeenInStep(await seed())).toBeUndefined();
  });
});
