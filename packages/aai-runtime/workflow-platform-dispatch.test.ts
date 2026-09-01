// Copyright 2026 the AAI authors. MIT license.
/**
 * The deployed dispatcher's four decisions.
 *
 * Every one of them is silent when wrong, and three of them strand a run rather
 * than failing anything a caller can see: `dispatch` returns nothing by contract,
 * so there is no promise to reject and no status to report.
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

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

/**
 * `dispatch` is fire-and-forget, so a spec has to wait for the call it made.
 *
 * `tick()` — a real macrotask yield — rather than an inline `setImmediate`, which
 * `guard-invariants` rule 4 rightly bans: the enqueue is a `fetch` plus a `.catch`,
 * so a microtask flush is not enough to see either.
 */
const settle = tick;

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
    dispatch("wrun_1");
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.queueName).toBe("__wkf_workflow_wrun_1");
    expect(sent[0]?.body.runId).toBe("wrun_1");
    expect(sent[0]?.body.delaySeconds).toBeUndefined();
  });

  test("converts a deadline to a delay in SECONDS, rounded up", async () => {
    // Rounded UP so a delivery is never earlier than the deadline the body
    // computed. Waking early is correct but wasteful — the run re-reads its own
    // stored `wakeAt`, finds it still ahead, and suspends again — and on a
    // deployed guest the wasted thing is a whole sandbox boot.
    const { dispatch, sent } = dispatchOver(ok);
    dispatch("wrun_1", Date.now() + 1500);
    await settle();
    expect(sent[0]?.body.delaySeconds).toBe(2);
  });

  test("clamps a deadline already past to zero rather than sending a negative", async () => {
    const { dispatch, sent } = dispatchOver(ok);
    dispatch("wrun_1", Date.now() - 60_000);
    await settle();
    expect(sent[0]?.body.delaySeconds).toBe(0);
  });

  test("a failed enqueue is LOGGED with the run id, because it strands the run", async () => {
    // The one that matters. There is no promise to reject and the platform's wake
    // sweep reads the QUEUE, so a run with a journal row and no message is
    // scheduled by nothing. The log line is the only trace and the only thing
    // that makes it recoverable by hand.
    const { dispatch, error } = dispatchOver(() => new Response("nope", { status: 500 }));
    dispatch("wrun_1", 1_700_000_000_000);
    await settle();
    expect(error).toHaveBeenCalledWith(
      "Workflow delivery could not be queued; run is not scheduled",
      expect.objectContaining({ runId: "wrun_1", wakeAt: 1_700_000_000_000 }),
    );
  });

  test("a failed enqueue does not THROW into the caller", async () => {
    // `dispatch` is called from inside `start`, which is inside a tool's
    // `execute`. A throw here would fail the tool call rather than the schedule.
    const { dispatch } = dispatchOver(() => {
      throw new Error("socket closed");
    });
    expect(() => dispatch("wrun_1")).not.toThrow();
    await settle();
  });
});
