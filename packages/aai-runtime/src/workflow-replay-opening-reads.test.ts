// Copyright 2026 the AAI authors. MIT license.
/**
 * The two journal reads a walk OPENS with, and that they are issued together.
 *
 * A latency claim rather than a behavioural one, which is why it is its own
 * file: nothing about the run's outcome changes either way, so a case stating
 * it has to observe the CALLS, and it does not belong among the replay
 * properties in `workflow-replay.test.ts` (which is 44 lines under the test cap
 * and should stay there).
 *
 * On the platform arm each read is one `POST /:slug/workflow-journal`, measured
 * at ~840 ms — see "A journal read is a round trip, and four shapes issued it N
 * times" in `packages/aai-runtime/CLAUDE.md`. `workflow-engine.ts` prefetches
 * the pair beside its `running` compare-and-set and hands both promises down,
 * so a DEPLOYED delivery was already paying one latency for the two; what this
 * pins is the path with nothing to prefetch, where the second call used not to
 * be made at all until the first resolved.
 */

import { describe, expect, test, vi } from "vitest";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import { replayRun } from "./workflow-replay.ts";

const RUN = "wrun_1";

/** A journal holding one running run, ready to replay. */
async function seed(): Promise<JournalStore> {
  const journal = createMemoryJournal();
  await journal.createRun({
    runId: RUN,
    workflow: "digest",
    status: "running",
    createdAt: Date.now(),
    input: {},
  });
  return journal;
}

describe("the two reads a walk opens with", () => {
  test("are ISSUED together, not one after the other", async () => {
    const journal = await seed();
    const order: string[] = [];
    const gate = Promise.withResolvers<void>();
    const slow: JournalStore = {
      ...journal,
      readSteps: async (runId) => {
        order.push("steps:start");
        await gate.promise;
        order.push("steps:end");
        return journal.readSteps(runId);
      },
      readSleeps: async (runId) => {
        order.push("sleeps:start");
        return journal.readSleeps(runId);
      },
    };

    const walk = replayRun({
      runId: RUN,
      workflow: "digest",
      input: {},
      run: () => "done",
      journal: slow,
    });
    // The step read is HELD OPEN, and the wait read has already been issued
    // anyway — which sequentially it could not have been, the call not yet
    // existing. Both started, neither finished, is the whole assertion.
    await vi.waitFor(() => {
      expect(order).toContain("sleeps:start");
    });
    expect(order).toEqual(["steps:start", "sleeps:start"]);
    gate.resolve();
    expect(await walk).toEqual({ kind: "completed", output: "done" });
  });
});
