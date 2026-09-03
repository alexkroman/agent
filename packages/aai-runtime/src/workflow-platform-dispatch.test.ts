// Copyright 2026 the AAI authors. MIT license.
/**
 * The deployed dispatcher's decisions.
 *
 * Every one of them is silent when wrong, and the queue name and the delay are
 * silent in both directions — a name the platform's claim never selects and a
 * delivery that arrives early both look like a run that is merely waiting. The
 * enqueue FAILING is the one with a caller to tell: `dispatch` resolves a promise
 * now, so a delivery whose re-enqueue could not be accepted is not acked.
 */

import { describe, expect, test, vi } from "vitest";
import { tick } from "./_test-utils.ts";
import { createPlatformDispatch, queueNameFor } from "./workflow-platform-dispatch.ts";

/** One enqueue the dispatcher attempted. */
type Sent = { url: string; body: Record<string, unknown> };

function dispatchOver(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const error = vi.fn();
  const fetchFn: typeof globalThis.fetch = async (url, init) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return answer();
  };
  const dispatch = createPlatformDispatch({
    platform: { base: "https://platform.test/digest-desk", token: "sandbox-token", fetch: fetchFn },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error },
  });
  return { dispatch, sent, error };
}

/**
 * An accepted enqueue, which is a `messageId` and not merely a 200.
 *
 * It used to be `{ ok: true }`, and every happy-path case here was really
 * asserting against a REJECTED enqueue — `enqueueToPlatform` throws "answered 200
 * without a messageId" on that body. The old `void send(...).catch(log)` swallowed
 * it, so the three cases below passed while measuring the failure path. Awaiting
 * the dispatch is what surfaced it.
 */
const ok = () => new Response(JSON.stringify({ messageId: "msg_1" }), { status: 200 });

/**
 * `dispatch` reports its own failure, so the cases that assert on the LOG have to
 * wait for the line rather than for the rejection.
 *
 * `tick()` — a real macrotask yield — rather than an inline `setImmediate`, which
 * `guard-invariants` rule 4 rightly bans: the enqueue is a `fetch`, so a microtask
 * flush is not enough to see it.
 */
const settle = tick;

/** An instant to compute deadlines against, so a case's arithmetic is exact. */
const NOW = 1_700_000_000_000;

/**
 * Pin `Date.now()`, because the delay is now MILLISECONDS and a case measuring
 * one cannot afford the millisecond that elapses between composing a deadline and
 * dispatching it. `restoreMocks` (see `vitest.shared.ts`) undoes the spy.
 */
function freezeClock(): void {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
}

/**
 * What the PLATFORM recovers from the field, which is what a delivery actually
 * waits: `enqueue` and `reschedule` (`aai-server/workflow-queue-store.ts`) both
 * do `Math.round(delaySeconds * 1000)` and Postgres computes `available_at` in
 * milliseconds. Asserting through it is what makes "never earlier than the
 * deadline" a claim about the delivery rather than about a float on this side.
 */
function recoveredMs(delaySeconds: unknown): number {
  return Math.round(Number(delaySeconds) * 1000);
}

describe("queueNameFor", () => {
  test("composes the ORCHESTRATION topic, which is what the platform's claim matches", () => {
    // The platform's claim splits the due set on this grammar: orchestration
    // serialized per run, steps fanned out. A replay wants exactly that
    // serialization, and a name composed differently here is a message the claim
    // silently never selects — a run that waits forever with a row in the queue.
    expect(queueNameFor("wrun_1")).toBe("__wkf_workflow_wrun_1");
  });
});

describe("createPlatformDispatch", () => {
  test("enqueues on the run's own topic with no delay for an immediate delivery", async () => {
    const { dispatch, sent } = dispatchOver(ok);
    await dispatch("wrun_1");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.queueName).toBe("__wkf_workflow_wrun_1");
    expect(sent[0]?.body.runId).toBe("wrun_1");
    expect(sent[0]?.body.delaySeconds).toBeUndefined();
  });

  test("keeps a sub-second wake's PRECISION, rather than ceiling it to a whole second", async () => {
    // This case is the defect: `Math.ceil((at - Date.now()) / 1000)` made every
    // sub-second deadline a `delaySeconds: 1`, so a measured `ctx.sleep(100)`
    // resumed at ~1,780 ms — ~1,000 of it this rounding, the rest the queue's own
    // poll interval, which is by design. Nothing below this field needs whole
    // seconds, so the delay the delivery gets is the delay the body asked for.
    const { dispatch, sent } = dispatchOver(ok);
    freezeClock();
    await dispatch("wrun_1", NOW + 100);
    expect(recoveredMs(sent[0]?.body.delaySeconds)).toBe(100);
  });

  test("converts a deadline to a delay in MILLISECONDS, rounded up", async () => {
    // Rounded UP so a delivery is never earlier than the deadline the body
    // computed. Waking early is correct but wasteful — the run re-reads its own
    // stored `wakeAt`, finds it still ahead, and suspends again — and on a
    // deployed guest the wasted thing is a whole sandbox boot. A fractional
    // deadline therefore ceils to the next whole millisecond, which is the
    // finest grain the wire carries.
    const { dispatch, sent } = dispatchOver(ok);
    freezeClock();
    await dispatch("wrun_1", NOW + 100.4);
    expect(recoveredMs(sent[0]?.body.delaySeconds)).toBe(101);
  });

  // The invariant that must not regress, over the shapes the two roundings meet:
  // a delivery is NEVER earlier than the deadline, and never more than the one
  // millisecond the ceil is allowed to cost. `recoveredMs` runs the server's own
  // conversion, so each case asserts what the delivery really gets rather than
  // the float this side wrote — a fractional second ceiled the other way round
  // could be rounded back DOWN there and arrive early after all.
  test.each([0.1, 1, 99, 100, 100.4, 999, 999.9, 1000, 1500, 60_000])(
    "a wake %s ms out is delivered no EARLIER than its deadline",
    async (remaining) => {
      const { dispatch, sent } = dispatchOver(ok);
      freezeClock();
      await dispatch("wrun_1", NOW + remaining);
      const delivered = recoveredMs(sent[0]?.body.delaySeconds);
      expect(delivered).toBeGreaterThanOrEqual(remaining);
      expect(delivered).toBeLessThan(remaining + 1);
    },
  );

  test("clamps a deadline already past to zero rather than sending a negative", async () => {
    const { dispatch, sent } = dispatchOver(ok);
    await dispatch("wrun_1", Date.now() - 60_000);
    expect(sent[0]?.body.delaySeconds).toBe(0);
  });

  test("a failed enqueue is LOGGED with the run id, because it strands the run", async () => {
    // The platform's wake sweep reads the QUEUE, so a run with a journal row and
    // no message is scheduled by nothing. The rejection below is what a delivery
    // acts on; this line is what a `start` — which cannot be made fallible —
    // leaves behind, and the only thing that makes that case recoverable by hand.
    const { dispatch, error } = dispatchOver(() => new Response("nope", { status: 500 }));
    await expect(dispatch("wrun_1", 1_700_000_000_000)).rejects.toThrow();
    await settle();
    expect(error).toHaveBeenCalledWith(
      "Workflow delivery could not be queued; run is not scheduled",
      expect.objectContaining({ runId: "wrun_1", wakeAt: 1_700_000_000_000 }),
    );
  });

  test("a failed enqueue REJECTS, so a delivery is not acked for a run it stranded", async () => {
    // The log alone is not enough, and this is the half that was missing.
    // `dispatch` used to be `void send(...).catch(log)`, so `execute` resolved
    // and `deliverQueueMessage` answered `200 {ok:true}` — telling the platform's
    // queue to forget a message whose replacement was never accepted. Rejecting
    // lets the awaiting caller answer 500, and the ORIGINAL message is retried.
    const { dispatch } = dispatchOver(() => new Response("nope", { status: 500 }));
    await expect(dispatch("wrun_1")).rejects.toThrow();
  });

  test("a failed enqueue does not throw SYNCHRONOUSLY into the caller", async () => {
    // `dispatch` is called from inside `start`, which is inside a tool's
    // `execute`. A synchronous throw there would fail the tool call rather than
    // the schedule, so the failure has to arrive as a rejection the engine
    // decides what to do with.
    const { dispatch } = dispatchOver(() => {
      throw new Error("socket closed");
    });
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = dispatch("wrun_1");
    }).not.toThrow();
    await expect(pending).rejects.toThrow("socket closed");
    await settle();
  });
});
