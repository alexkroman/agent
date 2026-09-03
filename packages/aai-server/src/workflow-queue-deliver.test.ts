// Copyright 2026 the AAI authors. MIT license.
/**
 * The hop: one claimed queue message into its tenant's guest.
 *
 * `workflow-queue-sweep.test.ts` covers what the sweep DOES with an answer; this
 * covers producing one. Two things carry the feature and neither is visible from
 * the sweep's suite:
 *
 * - The DevKit's answer has THREE shapes, and the third is `sleep()`. A 200
 *   carrying `{"timeoutSeconds": n}` means the run parked itself, and reading it
 *   as "completed" strands that run forever with nothing logged.
 * - What crosses to the guest is a contract: a bearer it will check, three
 *   `x-vqs-*` headers its entrypoint reads, and the devalue bytes unwrapped from
 *   the queue's own envelope. Every one of those is invisible in a diff.
 *
 * The broker is REAL — a resident sandbox in the slot cache — rather than mocked,
 * because "the message reaches a guest that has to be brokered first" is the
 * whole reason this module is not two lines inside the sweep.
 */

import { describe, expect, test } from "vitest";
import { GUEST_ROUTES } from "./guest-routes.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { captureLogs, createTestStore, fakeSandbox } from "./test-utils.ts";
import { createQueueDeliverer } from "./workflow-queue-deliver.ts";
import { isGuestUnreachable } from "./workflow-queue-failure.ts";
import type { QueuedMessage } from "./workflow-queue-store.ts";

const SLUG = "my-agent";
/** The devalue bytes a run really sends, and what must arrive unchanged. */
const BODY = "devalue bytes";

function envelope(over: Record<string, unknown> = {}): unknown {
  return { runId: "r1", data: Buffer.from(BODY).toString("base64"), ...over };
}

function message(over: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: "m1",
    slug: SLUG,
    queueName: "__wkf_step_r1",
    payload: envelope(),
    attempt: 0,
    ...over,
  };
}

/**
 * The minimum a deployed agent row needs.
 *
 * `deployPayload` is the HTTP route's BODY shape (`Record<string, unknown>`,
 * stringified by `deployBody`), and these specs write through the store instead —
 * a real broker needs a row and a version, not a deploy request.
 */
function agentRow(slug: string) {
  return {
    slug,
    env: {},
    worker:
      'export default { name: "a", systemPrompt: "p", greeting: "", maxSteps: 1, tools: {} };',
    clientFiles: {},
    credential_hashes: [],
  };
}

/** Records what crossed to the guest and answers as one. */
function recordingGuest(answer: () => Response = () => new Response("{}", { status: 200 })) {
  const calls: { url: string; method: string; headers: Headers; body: Buffer }[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: Buffer.from(await req.arrayBuffer()),
    });
    return answer();
  };
  return { calls, fetchFn };
}

/**
 * A deployed agent with a LIVE resident sandbox, so the real broker serves
 * without spawning anything.
 */
async function resident(
  answer?: () => Response,
  brokerOver: Partial<ResolveSandboxOpts> = {},
): Promise<{
  deliver: ReturnType<typeof createQueueDeliverer>;
  calls: ReturnType<typeof recordingGuest>["calls"];
}> {
  const store = createTestStore();
  const slots = createSlotCache();
  await store.putAgent(agentRow(SLUG));
  const version = (await store.getAgentVersion(SLUG)) ?? 1;
  setSlot(slots, { slug: SLUG, sandbox: fakeSandbox(), version });
  const guest = recordingGuest(answer);
  return {
    deliver: createQueueDeliverer({
      store,
      broker: { slots, store, ...brokerOver },
      fetchFn: guest.fetchFn,
    }),
    calls: guest.calls,
  };
}

describe("createQueueDeliverer", () => {
  const logs = captureLogs();

  describe("what crosses to the guest", () => {
    test("posts to the guest's delivery door, not a callback route", async () => {
      // The two callbacks are loopback-only; this door is the platform's, and
      // dialling a callback from here would be refused with a 403 the sweep
      // would read as a broken guest.
      const { deliver, calls } = await resident();
      await deliver(message());
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
      // `guestHttpUrl` swaps the guest's `wss://` origin for `https://`.
      expect(calls[0]?.url).toContain(GUEST_ROUTES.workflowQueue);
      expect(calls[0]?.url).toMatch(/^https:\/\/tunnel\.test/);
    });

    test("presents a bearer, which is what makes the door host-only", async () => {
      const { deliver, calls } = await resident();
      await deliver(message());
      // The value is an HMAC over this sandbox's fleet-wide name (guest-token.ts);
      // what matters here is that one is sent at all, since the guest answers 401
      // without it and the sweep would retry that to abandonment.
      expect(calls[0]?.headers.get("authorization")).toMatch(/^Bearer .+/);
    });

    test("sends the three headers the queue contract is made of", async () => {
      const { deliver, calls } = await resident();
      await deliver(message({ id: "m-7", queueName: "__wkf_workflow_r9", attempt: 2 }));
      const headers = calls[0]?.headers;
      // `x-vqs-queue-name` is what the guest ROUTES on: without it the guest
      // cannot tell a run replay from a step and answers 400.
      expect(headers?.get("x-vqs-queue-name")).toBe("__wkf_workflow_r9");
      expect(headers?.get("x-vqs-message-id")).toBe("m-7");
      expect(headers?.get("x-vqs-message-attempt")).toBe("2");
    });

    test("sends the devalue bytes, decoded from the envelope and byte-identical", async () => {
      // The payload column is jsonb because the CLAIM reads `runId` out of it,
      // so the bytes ride as base64 and this is the hop that unwraps them. A
      // body that arrived as the JSON envelope would fail inside the DevKit's
      // deserializer, several layers from the cause.
      const { deliver, calls } = await resident();
      await deliver(message());
      expect(calls[0]?.body.toString()).toBe(BODY);
      expect(calls[0]?.body).toEqual(Buffer.from(BODY));
    });

    test("carries the message's own headers without displacing the contract", async () => {
      const { deliver, calls } = await resident();
      await deliver(message({ headers: { "x-trace": "abc" } }));
      expect(calls[0]?.headers.get("x-trace")).toBe("abc");
      expect(calls[0]?.headers.get("x-vqs-queue-name")).toBe("__wkf_step_r1");
    });

    test("a message's own headers cannot overwrite the platform's", async () => {
      // The case above uses a key nothing else claims, so it passed while the
      // caller's spread came LAST and could replace every header beside it.
      // `message.headers` is a tenant's own `queue(name, msg, { headers })` and
      // `optionalHeaders` keeps no key allow-list, so these are values a tenant
      // can really send. Overriding the bearer makes the guest answer 401 and
      // the sweep burn all five attempts with nothing naming the payload;
      // overriding `x-vqs-queue-name` re-points the message at another
      // entrypoint.
      const { deliver, calls } = await resident();
      await deliver(
        message({
          headers: {
            authorization: "Bearer forged",
            "x-vqs-queue-name": "__wkf_workflow_someone_else",
            "x-vqs-message-id": "not-mine",
            "x-vqs-message-attempt": "0",
            "content-type": "text/plain",
          },
        }),
      );
      const headers = calls[0]?.headers;
      expect(headers?.get("authorization")).not.toBe("Bearer forged");
      expect(headers?.get("authorization")).toMatch(/^Bearer .+/);
      expect(headers?.get("x-vqs-queue-name")).toBe("__wkf_step_r1");
      expect(headers?.get("x-vqs-message-id")).toBe("m1");
      expect(headers?.get("x-vqs-message-attempt")).toBe("0");
      expect(headers?.get("content-type")).toBe("application/json");
    });
  });

  describe("the guest's answer", () => {
    test("a plain 2xx is completed", async () => {
      const { deliver } = await resident();
      await expect(deliver(message())).resolves.toEqual({ type: "completed" });
    });

    /**
     * The third outcome, and the one a two-state seam cannot express.
     *
     * `sleep(n)` inside a run makes the DevKit answer 200 with
     * `{"timeoutSeconds": n}`. Acking that message strands the run; failing it
     * spends the retry budget and then abandons it, which reads as a delivery
     * fault rather than a sleep.
     */
    test("a 200 carrying timeoutSeconds is a run that parked itself", async () => {
      const { deliver } = await resident(() => Response.json({ timeoutSeconds: 90 }));
      await expect(deliver(message())).resolves.toEqual({
        type: "reschedule",
        delaySeconds: 90,
      });
    });

    test("a zero-second park is still a park, not a completion", async () => {
      // `sleep(0)` is legal and means "come back as soon as you can". Treating
      // it as completed would drop the continuation.
      const { deliver } = await resident(() => Response.json({ timeoutSeconds: 0 }));
      await expect(deliver(message())).resolves.toEqual({
        type: "reschedule",
        delaySeconds: 0,
      });
    });

    test.each([
      ["a non-JSON body", () => new Response("ok", { status: 200 })],
      ["JSON without the field", () => Response.json({ ok: true })],
      ["a non-numeric field", () => Response.json({ timeoutSeconds: "soon" })],
      // These four all coerce through `Number()` to a finite non-negative — the
      // DevKit's own reader parks on every one of them. Read as a zero-second
      // park they would be REDELIVERED immediately, replay, answer the same
      // thing, and loop; so the ambiguous body is completed. See `parkedFor`.
      ["a null field", () => Response.json({ timeoutSeconds: null })],
      ["an empty-string field", () => Response.json({ timeoutSeconds: "" })],
      ["a boolean field", () => Response.json({ timeoutSeconds: true })],
      ["an array field", () => Response.json({ timeoutSeconds: [] })],
      ["a negative field", () => Response.json({ timeoutSeconds: -5 })],
      // No case for an INFINITE field: JSON cannot express one — `JSON.stringify`
      // writes `null` for `Infinity`, which is the first case above. The
      // `Number.isFinite` guard in `parkedFor` is therefore defensive against a
      // future non-JSON reader rather than against any body reachable here.
    ] as const)("%s is completed rather than a guess", async (_label, answer) => {
      // The DevKit's own reader does exactly this, a bare `catch {}` around the
      // parse, and guessing otherwise would park a healthy run indefinitely.
      const { deliver } = await resident(answer);
      await expect(deliver(message())).resolves.toEqual({ type: "completed" });
    });

    test("a 500 rejects, and carries the guest's own message", async () => {
      // A step that threw answers 500 with the tenant's message. Without it the
      // only record of why a run stalled is "HTTP 500".
      const { deliver } = await resident(
        () => new Response("TypeError: cannot read id", { status: 500 }),
      );
      await expect(deliver(message())).rejects.toThrow(/HTTP 500[\s\S]*cannot read id/);
    });

    test("a guest that ANSWERED is not unreachable, whatever it answered", async () => {
      // The other side of the classification, and the half that keeps it sound:
      // a 500 means the guest received the message, so it spends the message's
      // own budget. Reading it as unreachable would give a permanently failing
      // step ten patient minutes on top of its five attempts.
      const { deliver } = await resident(() => new Response("step threw", { status: 500 }));
      await expect(deliver(message())).rejects.not.toSatisfy(isGuestUnreachable);
    });

    test("a 400 rejects too, since an unroutable queue name is not a success", async () => {
      const { deliver } = await resident(() =>
        Response.json({ error: "unroutable queue name: nope" }, { status: 400 }),
      );
      await expect(deliver(message())).rejects.toThrow(/HTTP 400/);
    });
  });

  describe("when there is no guest to deliver to", () => {
    test("rejects rather than dropping when the broker refuses", async () => {
      // Refused because the replica is draining: the boot continues elsewhere and
      // the next tick joins it. A "drop this now" outcome would turn a routine
      // 503 into a lost run.
      const store = createTestStore();
      await store.putAgent(agentRow(SLUG));
      const deliver = createQueueDeliverer({
        store,
        broker: { slots: createSlotCache(), store, isDraining: () => true },
        fetchFn: recordingGuest().fetchFn,
      });
      await expect(deliver(message())).rejects.toThrow(/broker refused my-agent: HTTP 503/);
      // UNREACHABLE, which is what routes it to the patient budget rather than
      // the message's own five attempts: no request was sent, so nothing has
      // been learned about this message. A boot still in flight is exactly the
      // "up but not ready" case — see `workflow-queue-failure.ts`.
      await expect(deliver(message())).rejects.toSatisfy(isGuestUnreachable);
    });

    test("rejects for a slug with no agent at all", async () => {
      // Normally impossible, since the queue row's FK cascades on agent delete,
      // so this is a delete/redeploy race and the sweep's budget bounds it.
      const store = createTestStore();
      const deliver = createQueueDeliverer({
        store,
        broker: { slots: createSlotCache(), store },
        fetchFn: recordingGuest().fetchFn,
      });
      await expect(deliver(message({ slug: "gone" }))).rejects.toThrow(/HTTP 404/);
      await expect(deliver(message({ slug: "gone" }))).rejects.toSatisfy(isGuestUnreachable);
    });

    test("never reaches the guest when the broker refused", async () => {
      const store = createTestStore();
      await store.putAgent(agentRow(SLUG));
      const guest = recordingGuest();
      const deliver = createQueueDeliverer({
        store,
        broker: { slots: createSlotCache(), store, isDraining: () => true },
        fetchFn: guest.fetchFn,
      });
      await expect(deliver(message())).rejects.toThrow();
      expect(guest.calls).toEqual([]);
    });
  });

  describe("routing one slug's concurrent deliveries", () => {
    /**
     * The store the DELIVERER reads, counted — the broker gets the plain one, so
     * the count is exactly how many times the routing step ran.
     */
    function countingRoutes(store: ReturnType<typeof createTestStore>) {
      let reads = 0;
      return {
        reads: () => reads,
        store: {
          getAgentVersion: async (slug: string) => {
            reads += 1;
            return await store.getAgentVersion(slug);
          },
        },
      };
    }

    async function deliverConcurrently(count: number, hold: Promise<unknown>) {
      const store = createTestStore();
      const slots = createSlotCache();
      await store.putAgent(agentRow(SLUG));
      const version = (await store.getAgentVersion(SLUG)) ?? 1;
      setSlot(slots, { slug: SLUG, sandbox: fakeSandbox(), version });
      const counted = countingRoutes(store);
      const guest = recordingGuest();
      const deliver = createQueueDeliverer({
        store: counted.store,
        broker: { slots, store },
        // Every delivery is HELD open, so all `count` of them really overlap —
        // which is the window this collapses, and the only way to observe it.
        fetchFn: async (input, init) => {
          await hold;
          return await guest.fetchFn(input, init);
        },
      });
      const runs = Array.from({ length: count }, (_, i) =>
        deliver(message({ id: `m${i}`, payload: envelope({ runId: `r${i}` }) })),
      );
      return { runs, counted, guest };
    }

    test("routes ONCE for messages that overlap, and still delivers every one", async () => {
      // `claimDue` is `distinct on (slug, runId)`, so several messages for one
      // agent in a pass is the ordinary case rather than an edge one — and on a
      // cold slug the broker is the seconds-long part, so they overlap almost
      // entirely.
      const release = Promise.withResolvers<void>();
      const { runs, counted, guest } = await deliverConcurrently(4, release.promise);
      release.resolve();
      await expect(Promise.all(runs)).resolves.toEqual([
        { type: "completed" },
        { type: "completed" },
        { type: "completed" },
        { type: "completed" },
      ]);
      expect(counted.reads()).toBe(1);
      // The fan-out is UNCHANGED: sharing an answer to "where is this agent" is
      // not sharing a delivery.
      expect(guest.calls).toHaveLength(4);
    });

    test("retains nothing, so a later delivery routes again", async () => {
      // A brokered origin is only good while that sandbox is up. A memo would
      // hand the next pass an origin nothing is listening on.
      const { deliver } = await resident();
      await deliver(message({ id: "m1" }));
      await deliver(message({ id: "m2" }));
      const store = createTestStore();
      const slots = createSlotCache();
      await store.putAgent(agentRow(SLUG));
      const version = (await store.getAgentVersion(SLUG)) ?? 1;
      setSlot(slots, { slug: SLUG, sandbox: fakeSandbox(), version });
      const counted = countingRoutes(store);
      const sequential = createQueueDeliverer({
        store: counted.store,
        broker: { slots, store },
        fetchFn: recordingGuest().fetchFn,
      });
      await sequential(message({ id: "m1" }));
      await sequential(message({ id: "m2", payload: envelope({ runId: "r2" }) }));
      expect(counted.reads()).toBe(2);
    });

    test("a refusal reaches every joined delivery, and each one fails", async () => {
      const store = createTestStore();
      await store.putAgent(agentRow(SLUG));
      const deliver = createQueueDeliverer({
        store,
        broker: { slots: createSlotCache(), store, isDraining: () => true },
        fetchFn: recordingGuest().fetchFn,
      });
      const results = await Promise.allSettled([
        deliver(message({ id: "m1" })),
        deliver(message({ id: "m2", payload: envelope({ runId: "r2" }) })),
      ]);
      // Each settles its OWN message: the sweep's per-message isolation is what
      // turns these into two independent backoffs.
      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    });
  });

  describe("a payload the enqueue side should not have written", () => {
    test.each([
      ["not an object", "just a string"],
      ["no runId", { data: "AA==" }],
      ["an empty runId", { runId: "", data: "AA==" }],
      ["no data", { runId: "r1" }],
      ["null", null],
    ] as const)("rejects naming what was wrong: %s", async (_label, payload) => {
      // A permanent failure, since it will not become valid, so it spends the
      // retry budget and is abandoned with a warning. Accepted rather than
      // optimal: a distinct "drop now" outcome would be machinery for a case
      // that means the enqueue side wrote a row it should not have.
      const { deliver, calls } = await resident();
      await expect(deliver(message({ payload }))).rejects.toThrow(/queue payload/);
      // And nothing crossed: a message this guest cannot be sent must not be.
      expect(calls).toEqual([]);
    });
  });

  test("a park is reported at debug, not as an operational event", async () => {
    const { deliver } = await resident(() => Response.json({ timeoutSeconds: 3600 }));
    await deliver(message());
    expect(logs.warns()).toEqual([]);
    expect(logs.infos()).toEqual([]);
  });
});
