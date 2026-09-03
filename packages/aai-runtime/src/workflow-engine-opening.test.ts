// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal calls a DELIVERY opens with, and that they cost ONE round trip.
 *
 * A latency claim rather than a behavioural one, which is why it is its own file
 * — the sibling `workflow-replay-opening-reads.test.ts` makes the same kind of
 * claim one layer down, about the two reads `replayRun` opens with when nothing
 * prefetched them. Here the subject is `execute`: the run record, the step
 * snapshot, the wait snapshot and the `running` compare-and-set, each one
 * `POST /:slug/workflow-journal` on the platform arm at ~840 ms of server time.
 * They used to be one round trip and then three; a delivery pays one.
 *
 * The second case is not about latency at all. Issuing the compare-and-set
 * beside the record read means it can reach the store BEFORE the `createRun` a
 * racing `start` has in flight — answering `false` for a run that exists by the
 * time the record read answers — so a delivery that BELIEVED it would decline a
 * live run. `workflow-concurrent-delivery.test.ts` found exactly that under a
 * generated interleaving, shrunk to a step the body needed and nothing ever ran;
 * this states it directly, because a property that shrinks to a defect once is
 * not a regression for it. The third case is the other side of the same guard:
 * a set that lost because the run really is terminal has to stay lost.
 */

import { describe, expect, test, vi } from "vitest";
import { harness } from "./_workflow-engine-harness.ts";

describe("the calls a delivery opens with", () => {
  test("are ISSUED together, not one after the record read", async () => {
    const { engine, journal } = harness({ digest: () => "done" });
    const runId = await engine.start("digest", [{}]);
    const real = {
      getRun: journal.getRun.bind(journal),
      readSteps: journal.readSteps.bind(journal),
      readSleeps: journal.readSleeps.bind(journal),
      setStatus: journal.setStatus.bind(journal),
    };

    const started: string[] = [];
    const gate = Promise.withResolvers<void>();
    // Every opening call is HELD, so "all four were issued" is observable with
    // none of them having answered — which is the whole claim, and what a
    // sequential opening cannot satisfy: it does not make the second call until
    // the first resolves.
    const hold = <T>(name: string, answer: () => Promise<T>): Promise<T> => {
      started.push(name);
      return gate.promise.then(answer);
    };
    vi.spyOn(journal, "getRun").mockImplementation((id) => hold("getRun", () => real.getRun(id)));
    vi.spyOn(journal, "readSteps").mockImplementation((id) =>
      hold("readSteps", () => real.readSteps(id)),
    );
    vi.spyOn(journal, "readSleeps").mockImplementation((id) =>
      hold("readSleeps", () => real.readSleeps(id)),
    );
    vi.spyOn(journal, "setStatus").mockImplementation((id, next, patch, expected) =>
      hold("setStatus", () => real.setStatus(id, next, patch, expected)),
    );

    const delivery = engine.execute(runId);
    await vi.waitFor(() => {
      expect(started).toHaveLength(4);
    });
    expect(new Set(started)).toEqual(new Set(["getRun", "readSteps", "readSleeps", "setStatus"]));
    gate.resolve();
    expect(await delivery).toBe("completed");
  });

  test("re-ask a compare-and-set that lost, rather than declining a live run", async () => {
    const body = vi.fn(() => "done");
    const { engine, journal } = harness({ digest: body });
    const runId = await engine.start("digest", [{}]);

    const real = journal.setStatus.bind(journal);
    let raced = false;
    vi.spyOn(journal, "setStatus").mockImplementation(async (id, next, patch, expected) => {
      // The eager set landing ahead of `createRun`: no row matches, so it is
      // refused for a run the record read then finds alive.
      if (!raced && next === "running") {
        raced = true;
        return false;
      }
      return real(id, next, patch, expected);
    });

    expect(await engine.execute(runId)).toBe("completed");
    expect(body, "the delivery declined a run that was alive").toHaveBeenCalledTimes(1);
  });

  test("stay declined when the run really is one this delivery may not walk", async () => {
    const body = vi.fn(() => "done");
    const { engine, journal } = harness({ digest: body });
    const runId = await engine.start("digest", [{}]);
    await journal.setStatus(runId, "cancelled", undefined, ["pending", "running"]);

    // Both sets are refused, so the answer is the status the journal has — not
    // a walk, and not `undefined`.
    expect(await engine.execute(runId)).toBe("cancelled");
    expect(body).not.toHaveBeenCalled();
  });
});
