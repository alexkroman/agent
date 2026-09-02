// Copyright 2026 the AAI authors. MIT license.
/**
 * One read per run per tick, however many watchers there are.
 *
 * Three loops in this package watch a run by re-reading it on a timer — the
 * synchronous wait (250 ms), the SSE event stream (1 s), the notify watcher
 * (2 s) — and each justified its interval on the read being local. On a
 * deployed agent it is not: `selectJournal` puts the platform arm first, so
 * every `get(runId)` is a `POST /:slug/workflow-journal` over the network. And
 * one sandbox serves one slug fleet-wide, so three browser tabs watching one
 * run are three SSE streams in ONE guest process, each independently POSTing
 * the same read once a second.
 *
 * The first case is the regression, and it is stated over the REAL loops rather
 * than over this module's API: what was wrong was the total the three of them
 * put on the wire, and a spec over the multiplexer alone would have passed on
 * the day the bug was live.
 *
 * Virtual time throughout: the whole subject is an interval, so a spec that
 * waited out real milliseconds would be measuring the runner (see the root
 * guide's "A spec that observes a TIMER runs on virtual time").
 */

import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type EventSink, streamRunEvents } from "./workflow-api-events.ts";
import { WORKFLOW_WAIT_POLL_MS, waitForRun } from "./workflow-api-wait.ts";
import { createRunNotifier } from "./workflow-notify.ts";
import {
  createRunReads,
  isRunWatchClosed,
  type RunReader,
  readRunOnce,
} from "./workflow-run-reads.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function snapshot(over: Partial<WorkflowRunSnapshot> = {}): WorkflowRunSnapshot {
  return {
    runId: "wrun_1",
    workflow: "digest",
    createdAt: 0,
    status: "running",
    ...over,
  } as WorkflowRunSnapshot;
}

/** A sink that swallows everything: what these count is READS, not frames. */
function sink(): EventSink {
  const res: EventSink = {
    writeHead: () => res,
    write: () => true,
    end: () => undefined,
    on: () => res,
  };
  return res;
}

/** A live caller for {@link waitForRun}, which only asks whether it left. */
function caller(): Parameters<typeof waitForRun>[3] {
  return { destroyed: false, once: () => undefined, off: () => undefined };
}

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe("the three watching loops share one read", () => {
  test("three tabs and a notify watcher cost ONE read per tick, not four", async () => {
    // The measured case: three open tabs at RUN_EVENT_POLL_MS plus one notify
    // watch at RUN_NOTIFY_POLL_MS, on one run, in one process.
    const runs = { get: vi.fn(async () => snapshot()) };
    const streams = [
      streamRunEvents(sink(), runs, "wrun_1"),
      streamRunEvents(sink(), runs, "wrun_1"),
      streamRunEvents(sink(), runs, "wrun_1"),
    ];
    const notifier = createRunNotifier({
      client: runs,
      announcer: { announce: () => true },
      logger: silent,
    });
    notifier.watch({ sessionId: "s-1", runId: "wrun_1" });

    await vi.advanceTimersByTimeAsync(60_000);

    // 62: one per second — the tightest deadline any live watcher asked for —
    // plus the two the three joins take between them. It was 213 (61 per stream
    // and 30 for the notifier), i.e. 3.55 reads a second on one idle run.
    expect(runs.get.mock.calls.length).toBe(62);

    for (const stream of streams) stream.close();
    notifier.stop();
  });

  test("a synchronous waiter sets the pace for all of them, and is not slowed", async () => {
    // The worst measured case, 7.5 reads/s: the three tabs and the notifier
    // above with a `wait=` request alongside. The waiter reads four times a
    // second and the others now ride it, so the TOTAL is what the waiter alone
    // used to cost.
    const runs = { get: vi.fn(async () => snapshot()) };
    const streams = [
      streamRunEvents(sink(), runs, "wrun_1"),
      streamRunEvents(sink(), runs, "wrun_1"),
      streamRunEvents(sink(), runs, "wrun_1"),
    ];
    const notifier = createRunNotifier({
      client: runs,
      announcer: { announce: () => true },
      logger: silent,
    });
    notifier.watch({ sessionId: "s-1", runId: "wrun_1" });
    const waiting = waitForRun(runs, "wrun_1", 10_000, caller());

    await vi.advanceTimersByTimeAsync(10_000);
    await waiting;
    const shared = runs.get.mock.calls.length;

    // 10s at WORKFLOW_WAIT_POLL_MS is 40 reads for the waiter alone; the four
    // other watchers add only the reads their joins take.
    expect(shared).toBeLessThanOrEqual(10_000 / WORKFLOW_WAIT_POLL_MS + 4);
    // And the waiter was not slowed to the stream's second: it got its own
    // interval, which is the whole reason a deadline beats a subscription.
    expect(shared).toBeGreaterThanOrEqual(10_000 / WORKFLOW_WAIT_POLL_MS);

    for (const stream of streams) stream.close();
    notifier.stop();
  });
});

describe("createRunReads", () => {
  /** A reader answering a scripted sequence, holding the last value afterwards. */
  function reader(script: (WorkflowRunSnapshot | undefined)[]): RunReader & {
    get: ReturnType<typeof vi.fn>;
  } {
    let at = 0;
    return { get: vi.fn(async () => script[Math.min(at++, script.length - 1)]) };
  }

  test("three watchers of one run take ONE read per tick between them", async () => {
    const runs = reader([snapshot()]);
    const reads = createRunReads(runs);
    const watchers = [reads.watch("wrun_1"), reads.watch("wrun_1"), reads.watch("wrun_1")];

    // Every watcher pending, all asking for the same deadline: the tick is one
    // read, delivered to all three.
    const pending = watchers.map((watch) => watch.next(1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await Promise.all(pending)).toEqual([snapshot(), snapshot(), snapshot()]);
    expect(runs.get).toHaveBeenCalledTimes(1);

    // And it stays one per tick rather than one per watcher per tick.
    const again = watchers.map((watch) => watch.next(1000));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(again);
    expect(runs.get).toHaveBeenCalledTimes(2);

    for (const watch of watchers) watch.close();
  });

  test("the TIGHTEST deadline wins, and answers the slower watcher early", async () => {
    // A 250ms synchronous caller must not be slowed to a stream's second — and
    // the stream is answered on the caller's tick for free.
    const runs = reader([snapshot()]);
    const reads = createRunReads(runs);
    const slow = reads.watch("wrun_1");
    const quick = reads.watch("wrun_1");

    const slowRead = slow.next(1000);
    const quickRead = quick.next(250);
    const settled = vi.fn();
    void Promise.all([slowRead, quickRead]).then(settled);

    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toHaveBeenCalled();
    expect(runs.get).toHaveBeenCalledTimes(1);

    slow.close();
    quick.close();
  });

  test("the last watcher out stops the reader", async () => {
    const runs = reader([snapshot()]);
    const reads = createRunReads(runs);
    const watchers = [reads.watch("wrun_1"), reads.watch("wrun_1")];
    // Asserted on EAGERLY rather than awaited at the end: a rejection whose
    // handler attaches a turn later is an unhandled rejection, which
    // `fail-on-process-warning.mjs` rightly fails the run for.
    const closedFirst = expect(watchers[0]?.next(1000)).rejects.toSatisfy(isRunWatchClosed);
    const survivor = watchers[1]?.next(1000);

    watchers[0]?.close();
    await closedFirst;
    // One watcher left, so the run is still read.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs.get).toHaveBeenCalledTimes(1);
    expect(reads.size).toBe(1);
    await survivor;

    const alive = watchers[1];
    const closedLast = expect(alive?.next(1000)).rejects.toSatisfy(isRunWatchClosed);
    alive?.close();
    await closedLast;
    await vi.advanceTimersByTimeAsync(10_000);
    // Nothing further, and the entry is gone — this is a per-process map keyed
    // by run, and a reader outliving its last watcher is a leak of exactly the
    // kind that never looks like one.
    expect(runs.get).toHaveBeenCalledTimes(1);
    expect(reads.size).toBe(0);
  });

  test("a read that THROWS reaches every watcher, not just the first", async () => {
    // The classic coalescing bug: a shared failure only one caller sees. Here
    // it would be worse than a lost read — the SSE stream's failure cap and the
    // notifier's log line are both driven by seeing the error.
    const boom = new Error("world gone");
    const runs: RunReader = { get: vi.fn(async () => Promise.reject(boom)) };
    const reads = createRunReads(runs);
    const watchers = [reads.watch("wrun_1"), reads.watch("wrun_1"), reads.watch("wrun_1")];
    // The assertion is attached in the same turn as the call, for the reason
    // the case below states.
    const pending = watchers.map((watch) => expect(watch.next(1000)).rejects.toBe(boom));

    await vi.advanceTimersByTimeAsync(1000);

    await Promise.all(pending);
    expect(runs.get).toHaveBeenCalledTimes(1);
    for (const watch of watchers) watch.close();
  });

  test("a failed read does not wedge the shared reader", async () => {
    let calls = 0;
    const runs: RunReader = {
      get: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("blip");
        return snapshot({ status: "completed" });
      }),
    };
    const reads = createRunReads(runs);
    const watch = reads.watch("wrun_1");

    await expect(watch.next(0)).rejects.toThrow("blip");
    await expect(watch.next(0)).resolves.toMatchObject({ status: "completed" });
    watch.close();
  });

  test("a SETTLED read is never replayed — this is a coalescer, not a cache", async () => {
    // Getting this wrong turns a latency saving into stale data, which is far
    // worse than the cost it saves. A watcher arriving after a read has settled
    // gets a fresh one, whatever the previous one said.
    const runs = reader([snapshot({ status: "running" }), snapshot({ status: "completed" })]);
    const reads = createRunReads(runs);

    const first = reads.watch("wrun_1");
    expect(await first.next(0)).toMatchObject({ status: "running" });
    expect(runs.get).toHaveBeenCalledTimes(1);

    // A second watcher joining the SAME live entry, and a third arriving after
    // the entry was released: neither may be handed the settled snapshot.
    const second = reads.watch("wrun_1");
    expect(await second.next(0)).toMatchObject({ status: "completed" });
    expect(runs.get).toHaveBeenCalledTimes(2);
    first.close();
    second.close();

    const third = reads.watch("wrun_1");
    expect(await third.next(0)).toMatchObject({ status: "completed" });
    expect(runs.get).toHaveBeenCalledTimes(3);
    third.close();
  });

  test("a joining watcher's first look is immediate, not a tick away", async () => {
    // `waitForRun`'s whole value is that a fast run answers fast, and a page
    // that has just connected must not watch a spinner to be told about a run
    // that finished before it asked.
    const runs = reader([snapshot({ status: "completed" })]);
    const reads = createRunReads(runs);
    const watch = reads.watch("wrun_1");
    const settled = vi.fn();
    const first = watch.next(0).then(settled);

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalled();
    await first;
    watch.close();
  });

  test("two runs are two readers, not one", async () => {
    const runs = reader([snapshot()]);
    const reads = createRunReads(runs);
    const a = reads.watch("wrun_1");
    const b = reads.watch("wrun_2");
    await Promise.all([a.next(0), b.next(0)]);
    expect(runs.get.mock.calls.map((call) => call[0])).toEqual(["wrun_1", "wrun_2"]);
    expect(reads.size).toBe(2);
    a.close();
    b.close();
    expect(reads.size).toBe(0);
  });
});

describe("the registry crosses copies of this package", () => {
  /**
   * A fresh copy of the module, the way a second bundle gets one.
   *
   * A deployed guest has two: `createServer` — hence the wait loop and the
   * event stream — comes from the HARNESS's copy, while `createRunNotifier` is
   * built by `createRuntime` inside the BUNDLE's. Both hold the same
   * `WorkflowClient` object, so the registry is what has to be shared, and
   * `vi.resetModules()` is exactly a second copy.
   */
  async function loadCopy() {
    vi.resetModules();
    return await import("./workflow-run-reads.ts");
  }

  test("a run watched through ONE copy is read once for BOTH", async () => {
    const harness = await loadCopy();
    const bundle = await loadCopy();
    expect(harness).not.toBe(bundle);

    // The one thing both copies hold: the client object itself.
    const runs = { get: vi.fn(async () => snapshot()) };
    const stream = harness.watchRun(runs, "wrun_1");
    const notify = bundle.watchRun(runs, "wrun_1");

    const pending = [stream.next(1000), notify.next(2000)];
    // Far enough for the LOOSER deadline too, so a registry per copy fails on
    // the count rather than on a timeout — the shared one answers both at 1000
    // and reads nothing further.
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(pending);

    // Against a module-level registry this is 2: the notifier polls on a timer
    // of its own beside the stream it was supposed to join.
    expect(runs.get).toHaveBeenCalledTimes(1);
    stream.close();
    notify.close();
  });

  test("a DIFFERENT client is a different reader, in either copy", async () => {
    // Keyed by object identity rather than by run id: `aai dev` rebuilds the
    // client on every file save, and host mode has one per agent.
    const harness = await loadCopy();
    const first = { get: vi.fn(async () => snapshot()) };
    const second = { get: vi.fn(async () => snapshot()) };
    const a = harness.watchRun(first, "wrun_1");
    const b = harness.watchRun(second, "wrun_1");
    await Promise.all([a.next(0), b.next(0)]);
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(second.get).toHaveBeenCalledTimes(1);
    a.close();
    b.close();
  });
});

/**
 * The ONE-SHOT half. Three loops were sharing; the two ROUTES that read a run
 * once and answer were not, and they are the reads a watched run attracts most
 * of — `useWorkflowProgress` polls `GET /runs/:id/stream` once a second for the
 * life of a run, and every one of those was a platform round trip of its own
 * beside the ones the loops above were already collapsing.
 */
describe("readRunOnce", () => {
  test("six concurrent one-shot reads of a run cost TWO round trips, not six", async () => {
    // TWO rather than one because that is what the coalescing runner promises:
    // a trigger arriving mid-run cannot be vouched for by a run that started
    // before it, so the batch after the first read shares ONE trailing read
    // however many of them there are. The number that matters is that it does
    // not grow with the readers — six before, two now, and the same two at
    // sixty.
    const runs = { get: vi.fn(async () => snapshot()) };
    const answers = await Promise.all(Array.from({ length: 6 }, () => readRunOnce(runs, "wrun_1")));
    expect(answers).toEqual(Array.from({ length: 6 }, () => snapshot()));
    expect(runs.get).toHaveBeenCalledTimes(2);
  });

  test("it answers a watching stream's next observation for free", async () => {
    // The deployed shape: a page holding an SSE stream open AND polling the
    // output route beside it. The poll's read is taken on this call, and the
    // stream's pending waiter is drained into it rather than costing a tick of
    // its own — which is what "answered EARLY than asked is always legal" buys.
    const runs = { get: vi.fn(async () => snapshot()) };
    const stream = streamRunEvents(sink(), runs, "wrun_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.get).toHaveBeenCalledTimes(1);

    await readRunOnce(runs, "wrun_1");
    expect(runs.get).toHaveBeenCalledTimes(2);
    // And the stream did not then take one anyway.
    await vi.advanceTimersByTimeAsync(0);
    expect(runs.get).toHaveBeenCalledTimes(2);
    stream.close();
  });

  test("a failed read reaches the caller rather than the watch's own teardown", async () => {
    // The `finally` closes the watch on this path too, and a close rejects any
    // waiter still pending — so a one-shot reader that closed before reading
    // its own answer would report `Run watch closed` for every lost database.
    const runs = { get: vi.fn(async () => Promise.reject(new Error("journal 503"))) };
    await expect(readRunOnce(runs, "wrun_1")).rejects.toThrow("journal 503");
  });
});
