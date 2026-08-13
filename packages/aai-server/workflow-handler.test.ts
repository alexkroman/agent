// Copyright 2026 the AAI authors. MIT license.
/**
 * `/:slug/workflows/*` — the platform half of the durable-workflow API.
 *
 * The property that carries the feature is that this route EXISTS at all: a
 * workflow app's page is served from `/:slug/` and builds every request URL from
 * `location`, so it has no broker step and its calls land here. Without the
 * route they fall through to the platform's own `notFound` and read to the user
 * as a failure of the feature ("Could not start: Not found").
 * `guest-routes.test.ts` asserts the registration; these assert the forward.
 *
 * The rest is what a proxy has to get right and what a diff cannot show: which
 * headers cross, that a body is not buffered, and that an event stream is
 * relayed through a body THIS replica can end cleanly on shutdown.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { GUEST_ROUTE_EXPOSURE } from "./guest-routes.ts";
import { endLiveStreams, resetLiveStreams } from "./live-streams.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { createTestOrchestrator, deployAgent, type TestFetch } from "./test-utils.ts";

const { mockSpawnAgentServer } = vi.hoisted(() => ({ mockSpawnAgentServer: vi.fn() }));

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: mockSpawnAgentServer,
}));

function makeFakeSandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    sessionUrl: vi.fn(() => Promise.resolve("wss://tunnel.test:443/websocket")),
    guestOrigin: vi.fn(() => Promise.resolve("wss://tunnel.test:443")),
    drain: vi.fn(() => Promise.resolve()),
    alive: vi.fn(() => true),
    shutdown: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

/** Records what the platform forwarded, and answers as the guest would. */
function recordingGuest(answer: (req: Request) => Response | Promise<Response> = () => json({})) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init as RequestInit);
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: await req.text() });
    return await answer(req);
  };
  return { calls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An orchestrator with a deployed agent and a live resident sandbox. */
async function residentHarness(guestFetch?: typeof globalThis.fetch) {
  const slots = createSlotCache();
  const harness = await createTestOrchestrator({ slots, ...(guestFetch && { guestFetch }) });
  await deployAgent(harness.fetch, "my-agent");
  slots.claim("my-agent", {
    slug: "my-agent",
    sandbox: makeFakeSandbox(),
    version: (await harness.store.getAgentVersion("my-agent")) ?? 1,
  });
  return harness;
}

function get(fetch: TestFetch, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, init);
}

beforeEach(() => {
  resetLiveStreams();
  mockSpawnAgentServer.mockResolvedValue({
    sessionUrl: "wss://tunnel.test:443/websocket",
    guestOrigin: "wss://tunnel.test:443",
    activeSessions: vi.fn().mockResolvedValue(0),
    drain: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    alive: () => true,
    onExit: vi.fn(),
  });
});

describe("routing", () => {
  test("the exposure declares the three methods the guest answers", () => {
    // DELETE is the one that matters: `api.cancel(runId)` is a DELETE, and a
    // platform serving only GET and POST 404s every Stop button on a DEPLOYED
    // agent while the same page works under `aai dev`.
    expect(GUEST_ROUTE_EXPOSURE.workflows).toEqual({
      via: "proxied",
      methods: ["GET", "POST", "DELETE"],
    });
  });

  test("forwards the bare collection path", async () => {
    const guest = recordingGuest(() => json({ workflows: [{ name: "digest" }] }));
    const harness = await residentHarness(guest.fetchFn);
    const res = await get(harness.fetch, "/my-agent/workflows");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workflows: [{ name: "digest" }] });
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/workflows");
  });

  test("forwards a nested run path and its query", async () => {
    const guest = recordingGuest(() => json({ runs: [] }));
    const harness = await residentHarness(guest.fetchFn);
    await get(harness.fetch, "/my-agent/workflows/runs?workflow=digest&limit=3");
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/workflows/runs?workflow=digest&limit=3");
  });

  test("forwards a DELETE, which is what Stop is", async () => {
    const guest = recordingGuest(() => json({ runId: "wrun_1", cancelled: true }));
    const harness = await residentHarness(guest.fetchFn);
    const res = await get(harness.fetch, "/my-agent/workflows/runs/wrun_1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(guest.calls[0]?.method).toBe("DELETE");
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/workflows/runs/wrun_1");
  });

  test("forwards a POST body", async () => {
    const guest = recordingGuest(() => json({ runId: "wrun_9" }, 202));
    const harness = await residentHarness(guest.fetchFn);
    const res = await harness.fetch("/my-agent/workflows/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow: "digest" }),
    });
    expect(res.status).toBe(202);
    expect(guest.calls[0]?.body).toBe('{"workflow":"digest"}');
    expect(guest.calls[0]?.headers.get("content-type")).toBe("application/json");
  });
});

describe("headers", () => {
  test("forwards the bearer — the guest's own AAI_WORKFLOW_API_TOKEN gate", async () => {
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);
    await get(harness.fetch, "/my-agent/workflows", {
      headers: { Authorization: "Bearer s3cret", Cookie: "session=abc", Origin: "https://evil" },
    });
    expect(guest.calls[0]?.headers.get("authorization")).toBe("Bearer s3cret");
    // The browser's headers are this hop's business, not the guest's — the
    // guest's view of the caller must not become a description of the platform.
    expect(guest.calls[0]?.headers.get("cookie")).toBeNull();
    expect(guest.calls[0]?.headers.get("origin")).toBeNull();
  });

  test("returns the guest's own status and content type", async () => {
    const guest = recordingGuest(() => json({ error: "not found" }, 404));
    const harness = await residentHarness(guest.fetchFn);
    const res = await get(harness.fetch, "/my-agent/workflows/runs/gone");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("event streams", () => {
  /** A guest answering with an SSE body that never ends on its own. */
  function streamingGuest() {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("event: run\ndata: {}\n\n"));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    return {
      fetchFn,
      get controller() {
        return controller;
      },
    };
  }

  test("relays the stream and keeps its no-transform headers", async () => {
    const guest = recordingGuest(
      () =>
        new Response("event: done\ndata: {}\n\n", {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        }),
    );
    const harness = await residentHarness(guest.fetchFn);
    const res = await get(harness.fetch, "/my-agent/workflows/runs/wrun_1/events");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await expect(res.text()).resolves.toBe("event: done\ndata: {}\n\n");
  });

  test("a relayed stream is ENDED by shutdown rather than destroyed by the exit", async () => {
    // A chunked body cut mid-frame is a protocol error to whatever is reading;
    // in production that reader is Modal's in-container proxy, which reports it
    // as a transfer-encoding failure with nothing tying it to the scale-in.
    const guest = streamingGuest();
    const harness = await residentHarness(guest.fetchFn);
    const res = await get(harness.fetch, "/my-agent/workflows/runs/wrun_1/events");
    const reader = res.body?.getReader();
    await reader?.read();
    endLiveStreams();
    // A clean end: the next read reports `done`, not an error.
    await expect(reader?.read()).resolves.toMatchObject({ done: true });
  });
});

describe("availability", () => {
  test("an unknown slug is a 404", async () => {
    const harness = await createTestOrchestrator({});
    const res = await get(harness.fetch, "/nobody/workflows");
    expect(res.status).toBe(404);
  });

  test("an unreachable guest is a retryable 503, not a platform 500", async () => {
    // The sandbox was ready a moment ago, so a guest that went away between the
    // broker and the forward is the same retryable condition as a booting one.
    const harness = await residentHarness(() => Promise.reject(new Error("ECONNREFUSED")));
    const res = await get(harness.fetch, "/my-agent/workflows");
    expect(res.status).toBe(503);
  });
});
