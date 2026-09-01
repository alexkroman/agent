// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the platform's queue-delivery door.
 *
 * The subject is the queue NAME. It used to be a CLASSIFICATION — the grammar
 * named a flow topic or a step topic and the door routed to one of the DevKit's
 * two callbacks — and what survives is narrower and still load-bearing: the name
 * is where the RUN ID comes from, and the platform's claim matches the same
 * grammar to serialize orchestration per run.
 *
 * `queueNameKind` outlives the routing it existed for because the platform's SQL
 * matches both patterns it exports. A step topic reaching this door can now only
 * be a DevKit-era message in flight across a deploy, and answering 400 retires it
 * rather than spending the whole abandonment budget on it first.
 */

import { describe, expect, test, vi } from "vitest";
import { deliverQueueMessage, queueNameKind } from "./workflow-queue-dispatch.ts";

describe("queueNameKind", () => {
  // The grammar is `__[<namespace>_]wkf_(workflow|step)_<id>` — `parseQueueName`
  // in `@workflow/world`. Both namespaced spellings are real: the DevKit reads
  // `WORKFLOW_QUEUE_NAMESPACE`, so a deployment that sets one produces the
  // longer form and a classifier that only knew the short one would answer 400
  // for every message.
  test.each([
    ["__wkf_workflow_run_01H", "workflow"],
    ["__wkf_step_run_01H:step_3", "step"],
    ["__aai_wkf_workflow_r1", "workflow"],
    ["__aai_wkf_step_r1", "step"],
    ["__ns2_wkf_step_r1", "step"],
  ] as const)("classifies %s as %s", (name, kind) => {
    expect(queueNameKind(name)).toBe(kind);
  });

  test.each([
    // No id after the prefix — the prefix alone names no message.
    "__wkf_workflow_",
    "__wkf_step_",
    // Neither kind.
    "__wkf_hook_r1",
    // A namespace must start with a letter, per the DevKit's own pattern.
    "__2ns_wkf_step_r1",
    // Not the prefix at all — including the shape a caller might invent.
    "workflow_r1",
    "step",
    "",
    // Uppercase: the DevKit's pattern is lowercase-only, and accepting this
    // would mean two spellings of one queue.
    "__WKF_WORKFLOW_r1",
  ])("refuses to classify %s", (name) => {
    expect(queueNameKind(name)).toBeUndefined();
  });

  test("an absent header is not a queue name", () => {
    expect(queueNameKind(null)).toBeUndefined();
  });
});

describe("deliverQueueMessage", () => {
  const QUEUE_NAME_HEADER = "x-vqs-queue-name";

  const post = (queueName?: string) =>
    new Request("http://guest.local/workflow-queue", {
      method: "POST",
      headers: queueName === undefined ? {} : { [QUEUE_NAME_HEADER]: queueName },
      body: JSON.stringify({ runId: "from-payload" }),
    });

  test("re-walks the run the queue NAME names", async () => {
    // This is the whole door under the replay engine. A deployed guest's own
    // timers die with a sandbox that self-exits, so the platform's queue holds the
    // schedule and a due message boots the guest and arrives here.
    const deliver = vi.fn(async () => "completed");
    const res = await deliverQueueMessage(deliver, post("__wkf_workflow_wrun_7"));
    expect(res.status).toBe(200);
    expect(deliver).toHaveBeenCalledWith("wrun_7");
  });

  test("reads the name and NOT the payload, even when the payload carries an id", async () => {
    // The name is the field the platform's claim routes by and the one this engine
    // composed. A payload fallback was tried and removed: it couples this door to
    // the sending client for a case that cannot arise.
    const deliver = vi.fn(async () => undefined);
    await deliverQueueMessage(deliver, post("__wkf_workflow_wrun_7"));
    expect(deliver).toHaveBeenCalledWith("wrun_7");
    expect(deliver).not.toHaveBeenCalledWith("from-payload");
  });

  test("tolerates a namespaced name, which is the same grammar", async () => {
    const deliver = vi.fn(async () => undefined);
    await deliverQueueMessage(deliver, post("__acme_wkf_workflow_wrun_7"));
    expect(deliver).toHaveBeenCalledWith("wrun_7");
  });

  test("answers 200 for a run that is still SUSPENDED", async () => {
    // The platform acks on a 200, and a run that suspended again has been fully
    // served. Reporting "still waiting" as anything but success would have the
    // queue retry a wait — and burn an attempt doing it.
    const deliver = vi.fn(async () => "running");
    expect((await deliverQueueMessage(deliver, post("__wkf_workflow_r1"))).status).toBe(200);
  });

  test.each([
    ["a STEP topic", "__wkf_step_r1"],
    ["an unrelated name", "orders"],
    ["an empty id", "__wkf_workflow_"],
    ["no header at all", undefined],
  ])("answers 400 for %s, rather than 500", async (_label, queueName) => {
    // 400 versus 500 is what the platform's abandonment budget rests on. A 400
    // says "do not retry, this can never route" — a message with no id will not
    // grow one. A 500 would spend the whole budget first and abandon it anyway,
    // several minutes later. A step topic is included deliberately: this engine
    // runs a step inline during the walk and never as its own message, so such a
    // name can only be a DevKit-era message still in flight across a deploy.
    const deliver = vi.fn(async () => undefined);
    const res = await deliverQueueMessage(deliver, post(queueName));
    expect(res.status).toBe(400);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("lets a replay failure REJECT, so the door answers 500 and the queue retries", async () => {
    // A guest that was up and could not finish is exactly the case a retry is
    // for, and `serveFetch` is what turns the rejection into the 500.
    const deliver = vi.fn(async () => {
      throw new Error("journal unreachable");
    });
    await expect(deliverQueueMessage(deliver, post("__wkf_workflow_r1"))).rejects.toThrow(
      /journal unreachable/,
    );
  });
});
