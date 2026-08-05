// Copyright 2026 the AAI authors. MIT license.

import { afterEach, describe, expect, test, vi } from "vitest";
import { endLiveStreams, resetLiveStreams } from "./live-streams.ts";
import { createStudioProxy } from "./studio-proxy.ts";
import { createTestOrchestrator } from "./test-utils.ts";

/** Minimal Hono-context double: the proxy only reads c.req and c.json. */
function makeContext(req: Request) {
  return {
    req: { raw: req, method: req.method, url: req.url },
    json: (body: unknown, status?: number) =>
      Response.json(body, status === undefined ? {} : { status }),
  } as unknown as Parameters<ReturnType<typeof createStudioProxy>>[0];
}

// A relayed SSE body registers itself for shutdown; leaking one across tests
// would let a later `endLiveStreams()` end a stream it never opened. Reset
// rather than drain — draining latches the registry closed, which would make
// the next test's relayed body end itself the moment it registers.
afterEach(() => {
  resetLiveStreams();
});

describe("createStudioProxy", () => {
  test("forwards method, path, query, and auth header to the upstream", async () => {
    let seen: Request | undefined;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen = new Request(input as string, init);
      return Response.json({ ok: true });
    });
    const proxy = createStudioProxy("http://studio.internal:8080/", fetchFn);

    const res = await proxy(
      makeContext(
        new Request("https://platform.example/studio/projects?limit=5", {
          headers: { authorization: "Bearer key1", "accept-encoding": "gzip, br" },
        }),
      ),
    );

    expect(res.status).toBe(200);
    expect(seen?.url).toBe("http://studio.internal:8080/studio/projects?limit=5");
    expect(seen?.headers.get("authorization")).toBe("Bearer key1");
    // Dropped so the upstream answers identity — undici decompresses bodies
    // but leaves content-encoding headers, which would corrupt the relay.
    expect(seen?.headers.get("accept-encoding")).toBeNull();
  });

  test("streams the response through without buffering (SSE)", async () => {
    // An SSE-shaped body delivered in two chunks; the proxy must pass the
    // stream itself through, not a buffered copy.
    const chunks = ["data: first\n\n", "data: second\n\n"];
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    // An encoded upstream response: undici's fetch decompresses the body but
    // leaves content-encoding/content-length in place — re-serving either
    // header with the decompressed body corrupts the relay.
    const upstream = new Response(upstreamBody, {
      headers: {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
        "content-length": "999",
      },
    });
    const proxy = createStudioProxy("http://studio.internal:8080", async () => upstream);

    const res = await proxy(makeContext(new Request("https://platform.example/studio/chat")));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // Stale after transparent decompression — must not be relayed.
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();

    // An SSE body is relayed through a stream WE own (so shutdown can end it
    // — see live-streams.ts) rather than handed through by reference. It must
    // still arrive chunk by chunk: the relay is a pump, never a buffer.
    expect(res.body).not.toBe(upstreamBody);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(decoder.decode(value));
    }
    expect(seen).toEqual(chunks);
  });

  test("a non-SSE response stays a zero-copy passthrough", async () => {
    // Only long-lived streams pay for the relay; assets and JSON must not.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.close(),
    });
    const upstream = new Response(body, { headers: { "content-type": "application/json" } });
    const proxy = createStudioProxy("http://studio.internal:8080", async () => upstream);
    const res = await proxy(makeContext(new Request("https://platform.example/studio/projects")));
    expect(res.body).toBe(body);
  });

  test("shutdown ends a relayed SSE body instead of leaving it hanging", async () => {
    // Without this the agent replica's exit destroys the socket mid-chunk and
    // Modal's proxy reports a truncated chunked body.
    const upstream = new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
      headers: { "content-type": "text/event-stream" },
    });
    const proxy = createStudioProxy("http://studio.internal:8080", async () => upstream);
    const res = await proxy(makeContext(new Request("https://platform.example/studio/chat")));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const read = reader.read();

    expect(endLiveStreams()).toBe(1);
    expect(await read).toEqual({ done: true, value: undefined });
  });

  test("forwards a POST body", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = await new Request(input as string, init).text();
      return Response.json({ echoed: body });
    });
    const proxy = createStudioProxy("http://studio.internal:8080", fetchFn);
    const res = await proxy(
      makeContext(
        new Request("https://platform.example/studio/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ project: "p" }),
        }),
      ),
    );
    await expect(res.json()).resolves.toEqual({ echoed: '{"project":"p"}' });
  });

  test("passes upstream redirects through instead of following them", async () => {
    const proxy = createStudioProxy("http://studio.internal:8080", async () =>
      Response.redirect("http://studio.internal:8080/", 302),
    );
    const res = await proxy(makeContext(new Request("https://platform.example/studio/")));
    expect(res.status).toBe(302);
  });

  test("answers 502 when the upstream is unreachable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const proxy = createStudioProxy("http://studio.internal:8080", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const res = await proxy(makeContext(new Request("https://platform.example/studio/status")));
    expect(res.status).toBe(502);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

// ── Orchestrator proxy mode (split deployment) ──────────────────────────────

describe("orchestrator with studioUpstream", () => {
  test("studio surface goes upstream; agent surface stays local", async () => {
    const forwarded: string[] = [];
    const studioProxyFetch = (async (input: string | URL | Request) => {
      forwarded.push(input instanceof Request ? input.url : String(input));
      return Response.json({ from: "studio-service" });
    }) as typeof globalThis.fetch;

    const { fetch } = await createTestOrchestrator({
      studioUpstream: "http://studio.internal:8080",
      studioProxyFetch,
    });

    // Studio routes are forwarded, path and prefix intact.
    const status = await fetch("/studio/status");
    await expect(status.json()).resolves.toEqual({ from: "studio-service" });
    const root = await fetch("/");
    await expect(root.json()).resolves.toEqual({ from: "studio-service" });
    expect(forwarded).toEqual([
      "http://studio.internal:8080/studio/status",
      "http://studio.internal:8080/",
    ]);

    // Agent surface is still served locally — never proxied.
    const health = await fetch("/health");
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(forwarded).toHaveLength(2);
  });
});

describe("createStudioProxy forwarded origin", () => {
  test("forwards the PUBLIC scheme, not the cleartext hop it received", async () => {
    // Behind Modal this service is reached over plain HTTP, so forwarding
    // `url.protocol` told the studio the platform was http:// — and the
    // guest's `aai deploy` then lost its Authorization on the redirect.
    let seen: Request | undefined;
    const proxy = createStudioProxy("http://studio.internal:8080", async (input, init) => {
      seen = new Request(input as string, init);
      return Response.json({ ok: true });
    });

    await proxy(makeContext(new Request("http://agent.example.modal.run/studio/projects")));

    expect(seen?.headers.get("x-forwarded-proto")).toBe("https");
    expect(seen?.headers.get("x-forwarded-host")).toBe("agent.example.modal.run");
  });

  test("a loopback origin keeps http (local combined dev)", async () => {
    let seen: Request | undefined;
    const proxy = createStudioProxy("http://studio.internal:8080", async (input, init) => {
      seen = new Request(input as string, init);
      return Response.json({ ok: true });
    });

    await proxy(makeContext(new Request("http://localhost:8080/studio/projects")));

    expect(seen?.headers.get("x-forwarded-proto")).toBe("http");
    expect(seen?.headers.get("x-forwarded-host")).toBe("localhost:8080");
  });
});
