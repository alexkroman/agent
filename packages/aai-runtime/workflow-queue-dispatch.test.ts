// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the platform's queue-delivery door.
 *
 * The subject is the CLASSIFICATION: this module exists so the DevKit's
 * queue-name grammar is parsed on the side that depends on the DevKit, and a
 * classifier that guessed would run a step as a flow (or a flow as a step) with
 * no error anywhere near the cause.
 */

import { describe, expect, test, vi } from "vitest";
import {
  deliverQueueMessage,
  dispatchQueueMessage,
  QUEUE_NAME_HEADER,
  queueNameKind,
  WORKFLOW_QUEUE_PATH,
} from "./workflow-queue-dispatch.ts";
import type { WorkflowSurface } from "./workflow-serve.ts";

function surfaceOf(): WorkflowSurface {
  return {
    flow: vi.fn(async () => new Response("flow", { status: 200 })),
    step: vi.fn(async () => new Response("step", { status: 200 })),
  };
}

const deliver = (surface: WorkflowSurface, queueName: string | undefined, body = "payload") =>
  dispatchQueueMessage(
    surface,
    new Request(`http://guest.local${WORKFLOW_QUEUE_PATH}`, {
      method: "POST",
      headers: queueName === undefined ? {} : { [QUEUE_NAME_HEADER]: queueName },
      body,
    }),
  );

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

describe("dispatchQueueMessage", () => {
  test("routes a workflow message to flow, and only flow", async () => {
    const surface = surfaceOf();
    const res = await deliver(surface, "__wkf_workflow_r1");
    expect(res.status).toBe(200);
    expect(surface.flow).toHaveBeenCalledTimes(1);
    expect(surface.step).not.toHaveBeenCalled();
  });

  test("routes a step message to step, and only step", async () => {
    const surface = surfaceOf();
    const res = await deliver(surface, "__wkf_step_r1");
    expect(res.status).toBe(200);
    expect(surface.step).toHaveBeenCalledTimes(1);
    expect(surface.flow).not.toHaveBeenCalled();
  });

  test("hands the entrypoint the body and the headers it reads", async () => {
    // The `x-vqs-*` headers ARE the queue↔executor contract, and the body is the
    // DevKit's opaque payload. Anything this module rebuilt would be a second
    // place for that contract to be wrong, so the request goes through whole.
    const surface = surfaceOf();
    let seen: Request | undefined;
    surface.step = vi.fn(async (req: Request) => {
      seen = req;
      return new Response("ok");
    });
    await dispatchQueueMessage(
      surface,
      new Request(`http://guest.local${WORKFLOW_QUEUE_PATH}`, {
        method: "POST",
        headers: {
          [QUEUE_NAME_HEADER]: "__wkf_step_r1",
          "x-vqs-message-id": "m-7",
          "x-vqs-message-attempt": "2",
        },
        body: "devalue-bytes",
      }),
    );
    expect(seen?.headers.get("x-vqs-message-id")).toBe("m-7");
    expect(seen?.headers.get("x-vqs-message-attempt")).toBe("2");
    expect(await seen?.text()).toBe("devalue-bytes");
  });

  test("returns the entrypoint's own response rather than a summary of it", async () => {
    // The platform reads the DevKit's three-way answer off this response — a
    // 200 carrying `{"timeoutSeconds"}` is how `sleep()` works — so a wrapper
    // that reported success would strand every sleeping run.
    const surface = surfaceOf();
    surface.flow = vi.fn(async () => Response.json({ timeoutSeconds: 90 }, { status: 200 }));
    const res = await deliver(surface, "__wkf_workflow_r1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ timeoutSeconds: 90 });
  });

  test("a 500 from the entrypoint is passed through, not swallowed", async () => {
    const surface = surfaceOf();
    surface.step = vi.fn(async () => new Response("step threw", { status: 500 }));
    const res = await deliver(surface, "__wkf_step_r1");
    expect(res.status).toBe(500);
  });

  test.each([
    ["an unroutable name", "__wkf_hook_r1"],
    ["no name at all", undefined],
  ])("answers 400 naming the value for %s, and runs nothing", async (_label, name) => {
    // 400 rather than 500: the queue sent something this guest cannot route, and
    // the platform must not retry it into the abandonment budget as though the
    // guest were down. Naming the value is the whole diagnostic — a DevKit that
    // changed its grammar looks exactly like a corrupt header otherwise.
    const surface = surfaceOf();
    const res = await deliver(surface, name);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(name ?? "(absent)");
    expect(surface.flow).not.toHaveBeenCalled();
    expect(surface.step).not.toHaveBeenCalled();
  });

  test("resolves ONLY flow and step, whatever the queue name says", async () => {
    // This used to assert that no queue name reaches the WEBHOOK handler — the
    // one workflow route a third party calls, gated by its own path token rather
    // than by a queue name. That property is now structural: the webhook is not
    // on `WorkflowSurface` at all, having moved to `createServer` when the
    // replay engine replaced the DevKit's hook table. What is still worth
    // pinning is the general form, since the surface can grow another member.
    const surface = surfaceOf();
    for (const name of ["__wkf_workflow_r1", "__wkf_step_r1", "__wkf_webhook_r1"]) {
      await deliver(surface, name).catch(() => undefined);
    }
    expect(Object.keys(surface).sort()).toEqual(["flow", "step"]);
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
