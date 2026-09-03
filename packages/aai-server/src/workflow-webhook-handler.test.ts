// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/.well-known/workflow/v1/webhook/:token` — the platform half of
 * durable-run webhook delivery.
 *
 * Two properties carry the feature and neither is visible from the guest's own
 * suite: that the route EXISTS under `/:slug` for every verb a third party
 * might use (guest-routes.test.ts asserts the registration; these assert the
 * forward), and that a delivery to a run whose sandbox has EXITED boots one
 * rather than 404ing — which is the normal case, not the edge, since a durable
 * run outlives the call that started it and an agent guest self-exits on idle.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GUEST_ROUTE_EXPOSURE } from "./guest-routes.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import {
  captureLogs,
  createTestOrchestrator,
  deployAgent,
  fakeSandbox,
  spawnedAgent,
  type TestFetch,
} from "./test-utils.ts";

const { mockSpawnAgentServer } = vi.hoisted(() => ({
  // A cold broker must reach a real spawn for the "the guest exited" case to
  // mean anything, so the backend is faked one level down rather than the
  // sandbox being parked in the slot.
  mockSpawnAgentServer: vi.fn(),
}));

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: mockSpawnAgentServer,
}));

const TOKEN = "wh_abc123";
const WEBHOOK_PATH = `/my-agent/.well-known/workflow/v1/webhook/${TOKEN}`;

/** Records what the platform forwarded, and answers as the guest would. */
function recordingGuest(answer: () => Response = () => new Response(null, { status: 202 })) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    calls.push({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: await req.text(),
    });
    return answer();
  };
  return { calls, fetchFn };
}

/** An orchestrator with a deployed agent and a live resident sandbox. */
async function residentHarness(guestFetch?: typeof globalThis.fetch) {
  const slots = createSlotCache();
  const harness = await createTestOrchestrator({
    slots,
    ...omitUndefined({ guestFetch }),
  });
  await deployAgent(harness.fetch, "my-agent");
  setSlot(slots, {
    slug: "my-agent",
    sandbox: fakeSandbox(),
    version: (await harness.store.getAgentVersion("my-agent")) ?? 1,
  });
  return harness;
}

function post(fetch: TestFetch, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { method: "POST", ...init });
}

describe("/:slug/.well-known/workflow/v1/webhook/:token", () => {
  const logs = captureLogs();
  beforeEach(() => {
    // `restoreMocks` (vitest.shared.ts) registers `vi.spyOn` mocks only — it
    // clears neither the history nor the implementation of a plain `vi.fn()`.
    // So the call history has to be cleared HERE, or the spawn count below is
    // a statement about how many earlier tests in this file spawned rather
    // than about the case making the assertion.
    mockSpawnAgentServer.mockClear();
    mockSpawnAgentServer.mockResolvedValue(spawnedAgent());
  });

  test("forwards the delivery to the guest's own webhook endpoint, token included", async () => {
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);

    const res = await post(harness.fetch, WEBHOOK_PATH, {
      headers: {
        "Content-Type": "application/json",
        // A provider's authenticity header: the run verifies it, so the proxy
        // has to pass it through byte-for-byte.
        "Stripe-Signature": "t=1,v1=deadbeef",
      },
      body: '{"event":"payment.succeeded"}',
    });

    expect(res.status).toBe(202);
    expect(guest.calls).toHaveLength(1);
    const [call] = guest.calls;
    expect(call?.url).toBe(`https://tunnel.test/.well-known/workflow/v1/webhook/${TOKEN}`);
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe('{"event":"payment.succeeded"}');
    expect(call?.headers.get("Stripe-Signature")).toBe("t=1,v1=deadbeef");
  });

  test("returns the guest's own status and body", async () => {
    // `respondWith: "manual"` lets the RUN write the response, so the sender's
    // answer has to be the guest's rather than a platform-authored ack.
    const guest = recordingGuest(
      () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { "Content-Type": "application/json", "X-Run-Id": "run_1" },
        }),
    );
    const harness = await residentHarness(guest.fetchFn);

    const res = await post(harness.fetch, WEBHOOK_PATH);

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
    // The COST of `GUEST_WEBHOOK_RESPONSE_HEADERS` being an allow-list, asserted
    // rather than discovered: a tenant-chosen response header no longer crosses
    // this hop. This one used to, and nothing reads it — the sender is a
    // third-party webhook sender that reads a status code — but the direction of
    // the change belongs in a test, because the same line is what drops
    // `Refresh` and `Speculation-Rules`. See that constant's doc.
    expect(res.headers.get("X-Run-Id")).toBeNull();
  });

  test("keeps the query string, which is part of the URL the sender was given", async () => {
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);

    await post(harness.fetch, `${WEBHOOK_PATH}?attempt=2`);

    expect(guest.calls[0]?.url).toContain("?attempt=2");
  });

  test("does not forward the platform's own hop headers", async () => {
    // `host` names the platform, and `content-length` is re-framed by the
    // fetch that carries the body onward.
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);

    await post(harness.fetch, WEBHOOK_PATH, { body: "hi" });

    expect(guest.calls[0]?.headers.get("host")).toBeNull();
    expect(guest.calls[0]?.url).toContain("tunnel.test");
  });

  test("nor this hop's CREDENTIALS, which are not part of the message", async () => {
    // The forward was a deny-list of hop-by-hop names only, so `Cookie` (a
    // credential for THIS origin — agent pages and the studio are served from
    // it), `Authorization` (a platform bearer) and `X-Forwarded-*` all reached
    // tenant code. They describe the caller to US; the run receives the
    // SENDER'S message, which is why the rest still passes through unfiltered
    // (see the Stripe-Signature spec above).
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);

    await post(harness.fetch, WEBHOOK_PATH, {
      headers: {
        Cookie: "sb-access-token=super-secret",
        Authorization: "Bearer platform-api-key",
        "X-Forwarded-For": "203.0.113.7",
        "X-Forwarded-Host": "aai.example",
        "X-Custom-Provider-Header": "kept",
      },
      body: "hi",
    });

    const [call] = guest.calls;
    expect(call?.headers.get("cookie")).toBeNull();
    expect(call?.headers.get("authorization")).toBeNull();
    expect(call?.headers.get("x-forwarded-for")).toBeNull();
    expect(call?.headers.get("x-forwarded-host")).toBeNull();
    expect(call?.headers.get("x-custom-provider-header")).toBe("kept");
  });

  test("re-encodes a token so the guest still sees ONE path segment", async () => {
    // The guest rejects an embedded `/` before decoding (`webhookToken`), so a
    // token carrying one has to stay percent-encoded across the hop.
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);

    await post(harness.fetch, "/my-agent/.well-known/workflow/v1/webhook/a%2Fb");

    expect(guest.calls[0]?.url).toMatch(/\/webhook\/a%2Fb$/);
  });

  test.each([...GUEST_ROUTE_EXPOSURE.workflowWebhook.methods])(
    "answers %s, the one verb a delivery can arrive on",
    async (method) => {
      const guest = recordingGuest();
      const harness = await residentHarness(guest.fetchFn);

      const res = await harness.fetch(WEBHOOK_PATH, { method, body: "{}" });

      expect(res.status).toBe(202);
      expect(guest.calls[0]?.method).toBe(method);
    },
  );

  // The companion to the narrowing above, and the reason it was made: this
  // route is unauthenticated and its URL is handed out on purpose, so a
  // link-preview fetcher, crawler or mail scanner following it used to resolve
  // a run's waitpoint with `{}` — an approval firing with no human. Rejecting
  // at the EDGE matters more here than the verb alone suggests: this handler
  // brokers, so a forwarded scan is a Modal sandbox boot, not a wasted hop.
  test.each(["GET", "HEAD", "PUT", "PATCH", "DELETE"])(
    "refuses %s at the platform edge, never reaching the guest",
    async (method) => {
      const guest = recordingGuest();
      const harness = await residentHarness(guest.fetchFn);

      const res = await harness.fetch(WEBHOOK_PATH, { method });

      expect(res.status).not.toBe(202);
      expect(guest.calls).toHaveLength(0);
    },
  );

  test("boots a sandbox for a run whose guest has already exited", async () => {
    // The whole point of the route: a durable run outlives the call that
    // started it, and agent mode self-exits on idle — so the common case has
    // NO resident sandbox, and a webhook that 404'd there would strand the run
    // until someone dialled the agent by hand.
    const guest = recordingGuest();
    const slots = createSlotCache();
    const harness = await createTestOrchestrator({ slots, guestFetch: guest.fetchFn });
    await deployAgent(harness.fetch, "my-agent");
    expect(slots.get("my-agent")?.sandbox).toBeUndefined();

    const res = await post(harness.fetch, WEBHOOK_PATH);

    expect(res.status).toBe(202);
    expect(mockSpawnAgentServer).toHaveBeenCalledTimes(1);
    expect(guest.calls).toHaveLength(1);
  });

  test("404s an unknown slug", async () => {
    const guest = recordingGuest();
    const harness = await createTestOrchestrator({ guestFetch: guest.fetchFn });

    const res = await post(harness.fetch, "/no-such-agent/.well-known/workflow/v1/webhook/tok");

    expect(res.status).toBe(404);
    expect(guest.calls).toHaveLength(0);
  });

  test("answers 503 with a Retry-After while the sandbox is still booting", async () => {
    // The boot continues server-side and the sender's retry joins it — the
    // same deal a browser gets for free by re-brokering.
    const guest = recordingGuest();
    const slots = createSlotCache();
    const harness = await createTestOrchestrator({ slots, guestFetch: guest.fetchFn });
    await deployAgent(harness.fetch, "my-agent");
    setSlot(slots, {
      slug: "my-agent",
      sandbox: fakeSandbox({
        guestOrigin: vi.fn(() => new Promise<string>(() => undefined)),
        sessionUrl: vi.fn(() => new Promise<string>(() => undefined)),
      }),
      version: (await harness.store.getAgentVersion("my-agent")) ?? 1,
    });

    vi.useFakeTimers();
    let res: Response;
    try {
      const pending = post(harness.fetch, WEBHOOK_PATH);
      await vi.advanceTimersByTimeAsync(30_000);
      res = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(guest.calls).toHaveLength(0);
  });

  test("answers 502 when the brokered guest will not take the delivery", async () => {
    const harness = await residentHarness(() => Promise.reject(new Error("connect ECONNREFUSED")));

    const res = await post(harness.fetch, WEBHOOK_PATH);

    expect(res.status).toBe(502);
    expect(logs.warns()).not.toHaveLength(0);
  });

  test("refuses a body far past any real webhook payload", async () => {
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);

    const res = await post(harness.fetch, WEBHOOK_PATH, {
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(1_048_577),
    });

    expect(res.status).toBe(413);
    expect(guest.calls).toHaveLength(0);
  });
});
