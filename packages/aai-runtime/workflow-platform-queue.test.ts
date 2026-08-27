// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest's enqueue client.
 *
 * Two things carry it, and neither is visible in a diff:
 *
 * - The WIRE FORMAT. What this writes is read by the local world's
 *   `TypedJsonTransport`, several layers away and inside somebody else's package,
 *   so a mismatch surfaces as a deserialization failure with nothing pointing
 *   back here. The `Uint8Array` envelope is the part that is easy to get wrong
 *   and the part a run's own input depends on.
 * - FAILING rather than pretending. Every error here fails a step, which the
 *   platform's sweep retries against a freshly brokered guest — so a rejection is
 *   routine and a false success is a stranded run.
 */

import { describe, expect, test, vi } from "vitest";
import {
  createPlatformQueueSend,
  enqueueToPlatform,
  payloadRunId,
} from "./workflow-platform-queue.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

/** Records what crossed and answers as the platform would. */
function recordingPlatform(answer: () => Response = () => Response.json({ messageId: "wfq_1" })) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    return answer();
  };
  return { calls, fetch };
}

const sendWith = (answer?: () => Response) => {
  const platform = recordingPlatform(answer);
  return {
    send: createPlatformQueueSend({ base: BASE, token: TOKEN, fetch: platform.fetch }),
    ...platform,
  };
};

/** The body the platform received, parsed. */
function sentBody(raw: string | undefined): Record<string, unknown> {
  return JSON.parse(raw ?? "{}") as Record<string, unknown>;
}

describe("payloadRunId", () => {
  // Three spellings, because the DevKit uses three: a run invoke carries `runId`,
  // a step payload carries `workflowRunId`, and its health-check payload carries
  // a `correlationId` — which IS the right key for it, a health check being its
  // own one-message run.
  test.each([
    [{ runId: "r1" }, "r1"],
    [{ workflowRunId: "r2" }, "r2"],
    [{ __healthCheck: true, correlationId: "c1" }, "c1"],
  ])("reads the run id out of %o", (payload, expected) => {
    expect(payloadRunId(payload)).toBe(expected);
  });

  test("prefers runId when a payload carries more than one", () => {
    expect(payloadRunId({ runId: "r1", workflowRunId: "r2" })).toBe("r1");
  });

  test.each([
    ["an empty string", { runId: "" }],
    ["a non-string", { runId: 7 }],
    ["no key at all", { stepId: "s1" }],
    ["null", null],
    ["a string", "r1"],
  ])("declines %s rather than inventing one", (_label, payload) => {
    expect(payloadRunId(payload)).toBeUndefined();
  });
});

describe("createPlatformQueueSend", () => {
  test("posts to the agent's own enqueue route with its bearer", async () => {
    const { send, calls } = sendWith();
    await send("__wkf_step_r1", { runId: "r1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE}/workflow-enqueue`);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  test("tolerates a trailing slash on the base, which is operator-set", async () => {
    const platform = recordingPlatform();
    const send = createPlatformQueueSend({
      base: `${BASE}///`,
      token: TOKEN,
      fetch: platform.fetch,
    });
    await send("__wkf_step_r1", { runId: "r1" });
    expect(platform.calls[0]?.url).toBe(`${BASE}/workflow-enqueue`);
  });

  test("sends the run id the claim orders on, alongside the queue name", async () => {
    const { send, calls } = sendWith();
    await send("__wkf_workflow_r9", { runId: "r9" });
    const body = sentBody(calls[0]?.body);
    expect(body.queueName).toBe("__wkf_workflow_r9");
    expect(body.runId).toBe("r9");
  });

  test("passes the DevKit's queue options through untouched", async () => {
    const { send, calls } = sendWith();
    await send(
      "__wkf_step_r1",
      { runId: "r1" },
      {
        deploymentId: "dpl_1",
        idempotencyKey: "idem-1",
        headers: { "x-trace": "abc" },
        // How `sleep()` reaches the queue.
        delaySeconds: 90,
      },
    );
    const body = sentBody(calls[0]?.body);
    expect(body.deploymentId).toBe("dpl_1");
    expect(body.idempotencyKey).toBe("idem-1");
    expect(body.headers).toEqual({ "x-trace": "abc" });
    expect(body.delaySeconds).toBe(90);
  });

  describe("the wire format", () => {
    /**
     * The round trip that matters, spelled as the reader really does it.
     *
     * The local world's `createQueueHandler` deserializes with
     * `TypedJsonTransport`: `JSON.parse` with a reviver that turns
     * `{__type:"Uint8Array", data:"<base64>"}` back into a `Uint8Array`. This is
     * that reviver, and it is here rather than imported because
     * `@workflow/world-local` is a transitive dependency this package does not
     * declare — which is also why the format is reproduced in the source.
     */
    const devKitReviver = (_key: string, value: unknown): unknown => {
      if (
        value !== null &&
        typeof value === "object" &&
        (value as { __type?: unknown }).__type === "Uint8Array" &&
        typeof (value as { data?: unknown }).data === "string"
      ) {
        return new Uint8Array(Buffer.from((value as { data: string }).data, "base64"));
      }
      return value;
    };

    const deserialize = (base64: unknown): unknown =>
      JSON.parse(Buffer.from(String(base64), "base64").toString(), devKitReviver);

    test("survives the DevKit's own reviver unchanged", async () => {
      const { send, calls } = sendWith();
      const message = { runId: "r1", nested: { list: [1, "two", null], flag: true } };
      await send("__wkf_workflow_r1", message);
      expect(deserialize(sentBody(calls[0]?.body).data)).toEqual(message);
    });

    /**
     * The case the tagged envelope exists for.
     *
     * A run's `input` really is a `Uint8Array` on the resilient start path, and
     * plain `JSON.stringify` turns one into `{"0":1,"1":2}` — an object the
     * reviver leaves alone, so the run starts with garbage instead of its input.
     */
    test("carries a Uint8Array through as a Uint8Array, not an index map", async () => {
      const { send, calls } = sendWith();
      const input = new Uint8Array([0, 1, 127, 128, 255]);
      await send("__wkf_workflow_r1", { runId: "r1", runInput: { input } });
      const revived = deserialize(sentBody(calls[0]?.body).data) as {
        runInput: { input: unknown };
      };
      expect(revived.runInput.input).toBeInstanceOf(Uint8Array);
      expect(revived.runInput.input).toEqual(input);
    });

    test("sends the payload as base64, because the platform column is jsonb", async () => {
      // The claim reads `payload->>'runId'`, so the envelope has to be JSON — which
      // is why the bytes cannot simply be the body.
      const { send, calls } = sendWith();
      await send("__wkf_step_r1", { runId: "r1" });
      const data = sentBody(calls[0]?.body).data;
      expect(typeof data).toBe("string");
      expect(String(data)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    });
  });

  describe("failing rather than pretending", () => {
    test("returns the message id the PLATFORM settled on", async () => {
      // Not the one it minted: an idempotency key collapses onto the row already
      // queued, and the DevKit correlates on what it is handed back.
      const { send } = sendWith(() => Response.json({ messageId: "wfq_existing" }));
      await expect(send("__wkf_step_r1", { runId: "r1" })).resolves.toEqual({
        messageId: "wfq_existing",
      });
    });

    test("rejects a payload with no run id instead of inventing one", async () => {
      // Per-run ordering is the one guarantee the platform's claim provides, and a
      // message ordered against nothing silently loses it.
      const { send, calls } = sendWith();
      await expect(send("__wkf_step_r1", { stepId: "s1" })).rejects.toThrow(/no run id/);
      expect(calls).toEqual([]);
    });

    test.each([
      [400, "queueName is required"],
      [401, "unauthorized"],
      [501, "platform queue not configured"],
      [503, "could not queue the message"],
    ])("rejects on HTTP %i, carrying the platform's own message", async (status, message) => {
      const { send } = sendWith(() => Response.json({ error: message }, { status }));
      await expect(send("__wkf_step_r1", { runId: "r1" })).rejects.toThrow(
        new RegExp(`HTTP ${status}[\\s\\S]*${message}`),
      );
    });

    test.each([
      ["no messageId", () => Response.json({ ok: true })],
      ["a non-string messageId", () => Response.json({ messageId: 7 })],
      ["an empty messageId", () => Response.json({ messageId: "" })],
      ["a body that is not JSON", () => new Response("ok", { status: 200 })],
    ])("rejects a 200 with %s", async (_label, answer) => {
      // A 200 the contract does not cover is a platform that moved. Throwing means
      // the step retries and the run survives; a made-up id would let the DevKit
      // correlate against something that does not exist.
      const { send } = sendWith(answer);
      await expect(send("__wkf_step_r1", { runId: "r1" })).rejects.toThrow(/messageId/);
    });

    test("propagates a transport failure rather than swallowing it", async () => {
      const send = createPlatformQueueSend({
        base: BASE,
        token: TOKEN,
        fetch: vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      });
      await expect(send("__wkf_step_r1", { runId: "r1" })).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  test("enqueueToPlatform is usable directly, and names its own route on failure", async () => {
    const platform = recordingPlatform(() => new Response("nope", { status: 500 }));
    await expect(
      enqueueToPlatform(
        { base: BASE, token: TOKEN, fetch: platform.fetch },
        { queueName: "__wkf_step_r1", runId: "r1", data: "" },
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
