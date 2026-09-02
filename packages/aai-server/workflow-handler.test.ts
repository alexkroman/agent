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

import { sleep } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { GUEST_ROUTE_EXPOSURE } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { endLiveStreams, resetLiveStreams } from "./live-streams.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { notFoundMessage } from "./sandbox-broker.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import {
  createTestOrchestrator,
  deployAgent,
  fakeSandbox,
  spawnedAgent,
  type TestFetch,
} from "./test-utils.ts";
import { GUEST_PROXY_TOKEN_HEADER } from "./workflow-proxy-constants.ts";

const { mockSpawnAgentServer } = vi.hoisted(() => ({ mockSpawnAgentServer: vi.fn() }));

vi.mock("./sandbox-vm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-vm.ts")>()),
  spawnAgentServer: mockSpawnAgentServer,
}));

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
async function residentHarness(
  guestFetch?: typeof globalThis.fetch,
  /** Per-IP limiters for this surface — the rate-limit specs pin their order. */
  limiters: { surface?: RateLimiter; start?: RateLimiter } = {},
  /**
   * The slot cache, for a spec that has to REINSTALL a resident after the agent
   * row is gone — see the deleted-agent case.
   */
  slots = createSlotCache(),
) {
  const harness = await createTestOrchestrator({
    slots,
    ...omitUndefined({ guestFetch }),
    ...omitUndefined({ workflowRateLimiter: limiters.surface }),
    ...omitUndefined({ workflowStartRateLimiter: limiters.start }),
  });
  await deployAgent(harness.fetch, "my-agent");
  setSlot(slots, {
    slug: "my-agent",
    sandbox: fakeSandbox(),
    version: (await harness.store.getAgentVersion("my-agent")) ?? 1,
  });
  return harness;
}

function get(fetch: TestFetch, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, init);
}

beforeEach(() => {
  resetLiveStreams();
  mockSpawnAgentServer.mockResolvedValue(spawnedAgent());
});

describe("routing", () => {
  test("the exposure declares the four methods the guest answers", () => {
    // The last two are each a bug that shipped. `api.cancel(runId)` is a DELETE and
    // `api.uploadStream(id, file)` is a PUT, and a platform serving only GET and POST
    // 404s them on a DEPLOYED agent while the same page works under `aai dev` — which
    // for the PUT presented as a run that cancelled itself half a second after
    // starting, because the hook read the 404 as a failed upload.
    expect(GUEST_ROUTE_EXPOSURE.workflows).toEqual({
      via: "proxied",
      methods: ["GET", "POST", "PUT", "DELETE"],
    });
  });

  test("forwards a PUT, which is how a streamed upload reaches the guest", async () => {
    const guest = recordingGuest(() => json({ id: "abc", size: 3, complete: true }, 201));
    const harness = await residentHarness(guest.fetchFn);
    const res = await harness.fetch(
      new Request("https://platform.test/my-agent/workflows/uploads/abc?name=a.wav", {
        method: "PUT",
        body: "hi!",
      }),
    );
    expect(res.status).toBe(201);
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/workflows/uploads/abc?name=a.wav");
    expect(guest.calls[0]?.method).toBe("PUT");
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

  test("forwards an upload's raw body, name and declared type", async () => {
    // The one route on this surface whose body is MEANT to be large: the bytes
    // are the file, the filename rides in `?name=` and the type in the header
    // (see `workflow-api-uploads.ts`). It is also the route whose deadline the
    // proxy got wrong — the guest answers 201 only once the last byte is
    // stored, so the bound has to be `"activity"`; `guest-forward.test.ts` is
    // where that is asserted, and this is that the route exists at all.
    const guest = recordingGuest(() => json({ id: "upl_1", size: 5 }, 201));
    const harness = await residentHarness(guest.fetchFn);
    const res = await harness.fetch("/my-agent/workflows/uploads?name=standup.wav", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: "RIFF!",
    });
    expect(res.status).toBe(201);
    expect(guest.calls[0]?.url).toBe("https://tunnel.test/workflows/uploads?name=standup.wav");
    expect(guest.calls[0]?.body).toBe("RIFF!");
    expect(guest.calls[0]?.headers.get("content-type")).toBe("audio/wav");
  });

  test("forwards a Range on an upload read, so a step reads one window", async () => {
    // Dropped, a step asking for 64 KB of a 200 MB recording is answered with
    // the whole thing — correctly and uselessly. `Range` is in
    // `GUEST_API_REQUEST_HEADERS` for this, and the 206's own headers are in
    // `GUEST_API_RESPONSE_HEADERS` so the caller can place the bytes.
    const guest = recordingGuest(
      () =>
        new Response("abc", {
          status: 206,
          headers: { "Content-Range": "bytes 0-2/2048", "Accept-Ranges": "bytes" },
        }),
    );
    const harness = await residentHarness(guest.fetchFn);
    const res = await get(harness.fetch, "/my-agent/workflows/uploads/upl_1", {
      headers: { Range: "bytes=0-2" },
    });
    expect(guest.calls[0]?.headers.get("range")).toBe("bytes=0-2");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-2/2048");
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

  test("injects the manage bearer so the guest can refuse a DIRECT tunnel dial", async () => {
    const guest = recordingGuest();
    const harness = await residentHarness(guest.fetchFn);
    await get(harness.fetch, "/my-agent/workflows");
    // The guest gates `/workflows/*` on this header (aai-guest/harness-agent-mode.ts):
    // it proves the request came THROUGH the platform, so a direct dial of the
    // public sandbox tunnel — which bypasses the rate limiters this route is
    // wrapped in — is refused. Derived from the sandbox's fleet-wide name, so it
    // matches the AAI_GUEST_TOKEN the running guest was spawned with.
    const version = (await harness.store.getAgentVersion("my-agent")) ?? 1;
    expect(guest.calls[0]?.headers.get(GUEST_PROXY_TOKEN_HEADER)).toBe(
      guestTokenFor(agentSandboxName("my-agent", version)),
    );
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

  test("a DELETED agent whose resident is still live is a 404, not a 503", async () => {
    // The state this models is a replica that has not yet been TOLD. A deleted
    // agent's resident is terminated by `watchAgentInvalidation`, which rides the
    // agents table's Realtime stream — so on any replica but the deleting one the
    // row is already gone while the resident is still live, for as long as that
    // delivery takes (and `realtime-subscription-monitor.ts` exists because a
    // channel can be DOWN while rejoining forever, which makes the window
    // unbounded). `resolveSandbox`'s fast path serves that live resident WITHOUT
    // consulting the row, so the broker succeeds and the version check below is
    // what the request meets.
    //
    // Re-installing the slot after the delete is how the test holds that state:
    // the in-memory event emitter delivers synchronously, which no real replica
    // does. Without it this passes for the wrong reason — the broker's own 404 —
    // which is what the A/B against the unfixed handler showed.
    const guest = recordingGuest();
    const slots = createSlotCache();
    const harness = await residentHarness(guest.fetchFn, {}, slots);
    const version = (await harness.store.getAgentVersion("my-agent")) ?? 1;
    await harness.store.deleteAgent("my-agent");
    setSlot(slots, { slug: "my-agent", sandbox: fakeSandbox(), version });
    const res = await get(harness.fetch, "/my-agent/workflows/uploads/abc/parts");
    expect(res.status).toBe(404);
    // The SAME sentence the upload BYTE route answers for this condition
    // (`assertAgentExists`), so one upload loop cannot be told "gone" by one half
    // and "retry shortly" by the other — which is the reported bug.
    expect(await res.text()).toContain(notFoundMessage("my-agent"));
    // And nothing was forwarded to a guest whose agent is gone.
    expect(guest.calls).toEqual([]);
  });

  test("a delete landing MID-forward is a 404, not the unreachable guest's 503", async () => {
    // The reported failure exactly: the version read found the row, the delete
    // terminated the resident while the request was in flight, and the forward
    // died with `fetch failed <- aborted` — which is indistinguishable from a
    // crashed guest except by re-reading the row, so the row is what decides.
    const armed: { deleteAgent?: (slug: string) => Promise<void> } = {};
    const harness = await residentHarness(async () => {
      await armed.deleteAgent?.("my-agent");
      throw new Error("aborted");
    });
    armed.deleteAgent = (slug) => harness.store.deleteAgent(slug);
    const res = await get(harness.fetch, "/my-agent/workflows/uploads/abc/parts");
    expect(res.status).toBe(404);
  });
});

/**
 * The surface's two per-IP limits, and the ONE round trip they now cost.
 *
 * A start is counted against both — the surface cap and the much tighter start
 * cap — and the two used to be awaited one after the other. Against the durable
 * limiter (`createPgRateLimiter`, one upsert each on the shared admin connection)
 * that was two serial round trips in front of the one route whose work outlives
 * its reply. Concurrent, the ordering that decides WHICH limit a caller is told
 * about has to survive being read back rather than short-circuited, so that is
 * what these assert.
 */
describe("the workflow surface's rate limits", () => {
  /**
   * A limiter that refuses from `after` calls on, recording its ENTRY and its
   * EXIT.
   *
   * Both, because entry order alone cannot tell concurrent from serial — a serial
   * caller asks in the same order. What separates them is whether the second
   * limiter was entered before the first had answered, which needs a real wait in
   * between (`sleep`, not a microtask: awaiting a resolved promise lets a serial
   * caller finish the first check before the second is even started).
   */
  function limiter(name: string, order: string[], after = Number.POSITIVE_INFINITY) {
    let seen = 0;
    return {
      check: async () => {
        order.push(`enter:${name}`);
        seen += 1;
        await sleep(5);
        order.push(`exit:${name}`);
        return seen > after
          ? ({ ok: false, retryAfterSeconds: name === "surface" ? 11 : 22 } as const)
          : ({ ok: true } as const);
      },
    };
  }

  const startPath = "/my-agent/workflows/runs";

  test("a start asks both limiters, and asks them together", async () => {
    const order: string[] = [];
    const harness = await residentHarness(() => Promise.resolve(new Response("{}")), {
      surface: limiter("surface", order),
      start: limiter("start", order),
    });

    await harness.fetch(`http://platform.test${startPath}`, { method: "POST", body: "{}" });

    // Both entered before either answered. Serially this is
    // enter:surface, exit:surface, enter:start, exit:start.
    expect(order.slice(0, 2)).toEqual(["enter:surface", "enter:start"]);
    expect(order.slice(2).sort()).toEqual(["exit:start", "exit:surface"]);
  });

  test("a read asks only the surface limiter", async () => {
    const order: string[] = [];
    const harness = await residentHarness(() => Promise.resolve(new Response("{}")), {
      surface: limiter("surface", order),
      start: limiter("start", order),
    });

    await get(harness.fetch, "/my-agent/workflows");

    expect(order).toEqual(["enter:surface", "exit:surface"]);
  });

  test("the SURFACE limit is what a refused start is told about", async () => {
    // Ascending tightness, preserved without the short-circuit: both verdicts are
    // in hand, and the first refusal in that order is the one reported. Counting
    // the tighter limit instead would make the one route whose cost outlives its
    // reply the only route escaping the surface cap.
    const order: string[] = [];
    const harness = await residentHarness(() => Promise.resolve(new Response("{}")), {
      surface: limiter("surface", order, 0),
      start: limiter("start", order, 0),
    });

    const res = await harness.fetch(`http://platform.test${startPath}`, {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("11");
  });

  test("the start limit refuses on its own once the surface one is satisfied", async () => {
    const order: string[] = [];
    const harness = await residentHarness(() => Promise.resolve(new Response("{}")), {
      surface: limiter("surface", order),
      start: limiter("start", order, 0),
    });

    const res = await harness.fetch(`http://platform.test${startPath}`, {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("22");
  });
});
