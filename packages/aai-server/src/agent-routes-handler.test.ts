// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/api/*` — an agent's own `routes`, brokered to its sandbox.
 *
 * The route EXISTING is the feature: a page served at `/:slug/` calls
 * `fetch("api/…")`, which lands on the platform, and without this route every
 * deployed agent declaring `routes` 404'd while `aai dev` worked.
 * `guest/routes.test.ts` asserts the registration; these assert the forward.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createTestOrchestrator } from "./_orchestrator-test-utils.ts";
import { deployAgent, recordingGuest } from "./_request-test-utils.ts";
import { fakeSandbox, spawnedAgent } from "./_sandbox-test-utils.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { notFoundMessage } from "./sandbox/broker.ts";
import { attachSandbox, claimSlot, createSlotCache } from "./sandbox/slots.ts";
import type { SpawnAgentServer } from "./sandbox.ts";
import { GUEST_PROXY_TOKEN_HEADER } from "./workflow-proxy-constants.ts";

const mockSpawnAgentServer = vi.fn<SpawnAgentServer>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An orchestrator with a deployed agent and a live resident sandbox. */
async function residentHarness(
  guestFetch?: typeof globalThis.fetch,
  rateLimiter?: RateLimiter,
  slots = createSlotCache(),
) {
  const harness = await createTestOrchestrator({
    spawnAgentServer: mockSpawnAgentServer,
    slots,
    ...omitUndefined({ guestFetch, agentRoutesRateLimiter: rateLimiter }),
  });
  await deployAgent(harness.fetch, "my-agent");
  attachSandbox(
    claimSlot(slots, "my-agent"),
    fakeSandbox(),
    (await harness.store.getAgentVersion("my-agent")) ?? 1,
  );
  return harness;
}

beforeEach(() => {
  mockSpawnAgentServer.mockResolvedValue(spawnedAgent());
});

describe("routing", () => {
  test("forwards a nested path and its query to the guest's /api", async () => {
    const guest = recordingGuest(() => json({ id: "call_1", status: "queued" }));
    const harness = await residentHarness(guest.fetchFn);
    const res = await harness.fetch("/my-agent/api/v1/calls/call_1?verbose=1");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "call_1", status: "queued" });
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/api/v1/calls/call_1?verbose=1");
  });

  test("forwards the bare prefix", async () => {
    const guest = recordingGuest(() => json({}));
    const harness = await residentHarness(guest.fetchFn);
    await harness.fetch("/my-agent/api");
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/api");
  });

  test.each(["POST", "PUT", "PATCH", "DELETE"])("forwards a %s with its body", async (method) => {
    const guest = recordingGuest(() => json({}, 201));
    const harness = await residentHarness(guest.fetchFn);
    const res = await harness.fetch(
      new Request("https://platform.test/my-agent/api/v1/calls", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_number: "+14155550132" }),
      }),
    );
    expect(res.status).toBe(201);
    expect(guest.calls[0]?.method).toBe(method);
    expect(JSON.parse(guest.calls[0]?.body ?? "")).toEqual({ phone_number: "+14155550132" });
  });
});

describe("headers", () => {
  test("forwards Authorization — the route's own credential check — and drops cookies", async () => {
    const guest = recordingGuest(() => json({}));
    const harness = await residentHarness(guest.fetchFn);
    await harness.fetch("/my-agent/api/v1/calls", {
      headers: { Authorization: "Bearer k3y", Cookie: "session=abc", Origin: "https://evil" },
    });
    expect(guest.calls[0]?.headers.get("authorization")).toBe("Bearer k3y");
    expect(guest.calls[0]?.headers.get("cookie")).toBeNull();
    expect(guest.calls[0]?.headers.get("origin")).toBeNull();
  });

  test("forwards X-Api-Key — the other header `apiKeyRoute` can be told to read", async () => {
    const guest = recordingGuest(() => json({}));
    const harness = await residentHarness(guest.fetchFn);
    await harness.fetch("/my-agent/api/v1/calls", { headers: { "X-Api-Key": "k-9f2c" } });
    expect(guest.calls[0]?.headers.get("x-api-key")).toBe("k-9f2c");
  });

  test("never hands tenant code the sandbox's manage bearer", async () => {
    // A route receives its request headers WHOLE, so the proxy proof the
    // workflow forward injects would be readable by the agent's own code here.
    const guest = recordingGuest(() => json({}));
    const harness = await residentHarness(guest.fetchFn);
    await harness.fetch("/my-agent/api/v1/calls");
    expect(guest.calls[0]?.headers.get(GUEST_PROXY_TOKEN_HEADER)).toBeNull();
  });

  test("returns the route's own status, and drops a header outside the allow-list", async () => {
    const guest = recordingGuest(
      () =>
        new Response(JSON.stringify({ error: "nope" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Set-Cookie": "x=1" },
        }),
    );
    const harness = await residentHarness(guest.fetchFn);
    const res = await harness.fetch("/my-agent/api/v1/calls");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("availability", () => {
  test("an unknown slug is a 404", async () => {
    const harness = await createTestOrchestrator({ spawnAgentServer: mockSpawnAgentServer });
    expect((await harness.fetch("/nobody/api/x")).status).toBe(404);
  });

  test("an unreachable guest is a retryable 503", async () => {
    const harness = await residentHarness(() => Promise.reject(new Error("ECONNREFUSED")));
    expect((await harness.fetch("/my-agent/api/x")).status).toBe(503);
  });

  test("a DELETED agent whose resident is still live is a 404, and nothing is forwarded", async () => {
    // Re-installing the slot after the delete holds the state a replica the
    // delete has not reached yet is in (see workflow-handler.test.ts).
    const guest = recordingGuest(() => json({}));
    const slots = createSlotCache();
    const harness = await residentHarness(guest.fetchFn, undefined, slots);
    const version = (await harness.store.getAgentVersion("my-agent")) ?? 1;
    await harness.store.deleteAgent("my-agent");
    attachSandbox(claimSlot(slots, "my-agent"), fakeSandbox(), version);
    const res = await harness.fetch("/my-agent/api/x");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(notFoundMessage("my-agent"));
    expect(guest.calls).toEqual([]);
  });
});

describe("rate limit", () => {
  test("a refused caller gets 429 with Retry-After and never reaches the guest", async () => {
    const guest = recordingGuest(() => json({}));
    const refuse: RateLimiter = {
      check: async () => ({ ok: false, retryAfterSeconds: 17 }),
    };
    const harness = await residentHarness(guest.fetchFn, refuse);
    const res = await harness.fetch("/my-agent/api/v1/calls");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(guest.calls).toEqual([]);
  });
});
