// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the run notifier.
 *
 * What is worth pinning is the LIFECYCLE, not the polling: a run that lands is
 * announced exactly once, a session that has gone away is not chased, and a
 * failed run says something different from a completed one — the agent is about
 * to read whatever this produces to a caller.
 *
 * Virtual time throughout: the interval is two seconds in production, and a
 * spec that waited it out would be both slow and a race (see the root guide's
 * "A spec that observes a TIMER runs on virtual time").
 */

import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createRunNotifier, instructionFor } from "./workflow-notify.ts";

function run(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "research",
    createdAt: 1_700_000_000_000,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A notifier over a scripted sequence of reads, with a recording announcer.
 *
 * The logger is per-harness: `restoreMocks` restores `vi.spyOn` mocks and
 * clears neither the history nor the implementation of a plain `vi.fn()`, so a
 * module singleton would let an earlier test's identical call satisfy the
 * `logger.info` assertion below.
 */
function harness(reads: (WorkflowRunSnapshot | undefined)[], opts: { spoke?: boolean } = {}) {
  const spoken: { sessionId: string; instruction: string }[] = [];
  const logger = makeLogger();
  let at = 0;
  const get = vi.fn(async () => reads[Math.min(at++, reads.length - 1)]);
  const notifier = createRunNotifier({
    client: { get } as never,
    announcer: {
      announce: (sessionId, instruction) => {
        spoken.push({ sessionId, instruction });
        return opts.spoke ?? true;
      },
    },
    logger,
    pollMs: 10,
    maxMs: 10_000,
  });
  return { notifier, spoken, get, logger };
}

describe("createRunNotifier", () => {
  test("announces once the run reaches a terminal status", async () => {
    const { notifier, spoken } = harness([
      run({ status: "running" }),
      run({ status: "completed", output: { summary: "tulips were fine" } }),
    ]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });

    await vi.advanceTimersByTimeAsync(10);
    expect(spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);

    expect(spoken).toHaveLength(1);
    expect(spoken[0]?.sessionId).toBe("sid-1");
    expect(spoken[0]?.instruction).toContain("tulips were fine");
  });

  test("stops watching once it has announced", async () => {
    const { notifier, spoken, get } = harness([run({ status: "completed" })]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    await vi.advanceTimersByTimeAsync(10);
    expect(notifier.size).toBe(0);

    const reads = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(get.mock.calls.length).toBe(reads);
    expect(spoken).toHaveLength(1);
  });

  test("does not watch the same run twice for one session", async () => {
    const { notifier } = harness([run()]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    expect(notifier.size).toBe(1);
  });

  test("watches the same run for two sessions — a caller who redialled", async () => {
    const { notifier, spoken } = harness([run({ status: "completed" })]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    notifier.watch({ sessionId: "sid-2", runId: "wrun_1" });
    await vi.advanceTimersByTimeAsync(10);
    expect(spoken.map((one) => one.sessionId)).toEqual(["sid-1", "sid-2"]);
  });

  test("gives up on a run that no longer exists", async () => {
    // A redeployed agent on a fresh database: announcing nothing is right.
    const { notifier, spoken } = harness([undefined]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_gone" });
    await vi.advanceTimersByTimeAsync(50);
    expect(spoken).toEqual([]);
    expect(notifier.size).toBe(0);
  });

  test("keeps watching through a transient read failure", async () => {
    const spoken: string[] = [];
    let call = 0;
    const notifier = createRunNotifier({
      client: {
        get: async () => {
          call += 1;
          if (call === 1) throw new Error("connection reset");
          return run({ status: "completed" });
        },
      } as never,
      announcer: {
        announce: (_sid, instruction) => {
          spoken.push(instruction);
          return true;
        },
      },
      logger: makeLogger(),
      pollMs: 10,
    });
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });

    await vi.advanceTimersByTimeAsync(10);
    expect(spoken).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(spoken).toHaveLength(1);
  });

  test("gives up at its deadline rather than polling forever", async () => {
    const { notifier, spoken, get } = harness([run({ status: "running" })]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    await vi.advanceTimersByTimeAsync(10_050);
    const reads = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);

    expect(get.mock.calls.length).toBe(reads);
    expect(spoken).toEqual([]);
    expect(notifier.size).toBe(0);
  });

  test("records that a session could not be spoken to, rather than retrying", async () => {
    // What an S2S agent gets for every run: the transport has no injected-turn
    // verb, so `announce` is false — and an author whose agent never speaks up
    // needs that in the log rather than inferred from silence.
    const { notifier, spoken, logger } = harness([run({ status: "completed" })], { spoke: false });
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    await vi.advanceTimersByTimeAsync(10);

    expect(spoken).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Workflow run announced",
      expect.objectContaining({ spoke: false }),
    );
  });

  test("stop() ends every watch", async () => {
    const { notifier, spoken, get } = harness([run({ status: "running" })]);
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    notifier.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(get).not.toHaveBeenCalled();
    expect(spoken).toEqual([]);
  });

  test("stop() refuses new watches — the runtime is going away", () => {
    const { notifier } = harness([run()]);
    notifier.stop();
    notifier.watch({ sessionId: "sid-1", runId: "wrun_1" });
    expect(notifier.size).toBe(0);
  });
});

describe("instructionFor", () => {
  const request = { sessionId: "sid-1", runId: "wrun_1" };

  test("names the workflow the RUN reports, and quotes the output", () => {
    const text = instructionFor(request, run({ status: "completed", output: { angles: 3 } }));
    expect(text).toContain('"research"');
    expect(text).toContain('{"angles":3}');
    expect(text).toContain("in your own words");
  });

  test("takes the author's own instruction when there is one", () => {
    const text = instructionFor(
      { ...request, instruction: "Read the headline only." },
      run({ status: "completed", output: {} }),
    );
    expect(text).toContain("Read the headline only.");
    expect(text).not.toContain("in your own words");
  });

  test("says something DIFFERENT about a failed run", () => {
    const text = instructionFor(request, run({ status: "failed", error: "gateway 500" }));
    expect(text).toContain("FAILED");
    expect(text).toContain("gateway 500");
    expect(text).toContain("apologize");
  });

  test("mentions a cancelled run rather than dropping the promise silently", () => {
    const text = instructionFor(request, run({ status: "cancelled" }));
    expect(text).toContain("cancelled");
  });
});
