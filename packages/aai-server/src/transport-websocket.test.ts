// Copyright 2025 the AAI authors. MIT license.
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { createOrchestrator } from "./orchestrator.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import {
  createTestOrchestrator,
  createTestStore,
  deploy,
  deployAgent,
  fakeSandbox,
} from "./test-utils.ts";

describe("handleAgentHealth", () => {
  test("returns 404 for non-existent agent", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/no-agent/health");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain("Not found");
  });

  test("returns ok for deployed agent", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; slug: string };
    expect(json.status).toBe("ok");
    expect(json.slug).toBe("my-agent");
  });
});

describe("handleAgentClientConfig", () => {
  /**
   * Deploy `slug` and install a resident fake sandbox in its slot — the
   * broker must reuse it (resolveSandbox fast path) rather than spawning a
   * real one. Seeded AFTER deploying (the deploy replaces the slug's slot),
   * at the deploy's version so the resident isn't invalidated as stale.
   */
  async function seedResident(
    fetch: Awaited<ReturnType<typeof createTestOrchestrator>>["fetch"],
    store: Awaited<ReturnType<typeof createTestOrchestrator>>["store"],
    slots: ReturnType<typeof createSlotCache>,
    slug: string,
    sandbox: Sandbox = fakeSandbox(),
  ): Promise<void> {
    await deployAgent(fetch, slug);
    setSlot(slots, {
      slug,
      sandbox,
      version: (await store.getAgentVersion(slug)) ?? 1,
    });
  }

  test("returns 404 for non-existent agent", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/no-agent/client-config");
    expect(res.status).toBe(404);
  });

  test("brokers the sandbox's live sessionUrl with name/greeting PROXIED from the guest", async () => {
    // A resident fake sandbox: the broker must reuse it (resolveSandbox fast
    // path) rather than spawning a real one. Name/greeting come from the
    // GUEST'S own /client-config — the bundle's live agent definition — not
    // from the stored config, which is opaque to the host.
    const slots = createSlotCache();
    const guestUrls: string[] = [];
    const guestFetch: typeof globalThis.fetch = async (input) => {
      guestUrls.push(String(input));
      return Response.json({
        name: "guest-agent",
        greeting: "hello from the bundle",
        page: "voice",
      });
    };
    const { fetch, store } = await createTestOrchestrator({ slots, guestFetch });
    await seedResident(fetch, store, slots, "my-agent");
    const res = await fetch("/my-agent/client-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "guest-agent",
      greeting: "hello from the bundle",
      sessionUrl: "wss://tunnel.test:443/websocket",
      page: "voice",
    });
    // The proxy dialed the sandbox's own origin, scheme swapped ws→http
    // (URL normalization drops the default :443).
    expect(guestUrls).toEqual(["https://tunnel.test/client-config"]);
  });

  test("a guest that cannot answer its config degrades to sessionUrl only", async () => {
    const slots = createSlotCache();
    const guestFetch: typeof globalThis.fetch = async () => {
      throw new Error("guest not answering");
    };
    const { fetch, store } = await createTestOrchestrator({ slots, guestFetch });
    await seedResident(fetch, store, slots, "my-agent");
    const res = await fetch("/my-agent/client-config");
    // Answered, with the one field a client cannot do without: the session
    // URL, plus the front door every config states. The default client renders
    // its empty defaults for the rest.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionUrl: "wss://tunnel.test:443/websocket",
      page: "voice",
    });
  });

  test("two slugs on one reused loopback port do not share a memoized config", async () => {
    // The memo was keyed on the guest ORIGIN alone, justified by "a guest origin
    // is unique to one sandbox". True of a Modal tunnel hostname; false of the
    // subprocess backend, whose guests are `ws://127.0.0.1:<port>` on a port the
    // OS is free to hand out again — so within the 10-minute TTL, B's page load
    // could be answered with A's name and greeting.
    const slots = createSlotCache();
    const names = ["agent-a", "agent-b"];
    const guestFetch: typeof globalThis.fetch = async () =>
      Response.json({ name: names.shift() ?? "exhausted", page: "voice" });
    const { fetch, store } = await createTestOrchestrator({ slots, guestFetch });

    // One port, two sandboxes: A's guest exits, B's lands on the same port.
    const onOnePort = (): Sandbox => ({
      ...fakeSandbox(),
      sessionUrl: vi.fn(() => Promise.resolve("ws://127.0.0.1:41234/websocket")),
      guestOrigin: vi.fn(() => Promise.resolve("ws://127.0.0.1:41234")),
    });
    await seedResident(fetch, store, slots, "agent-one", onOnePort());
    await seedResident(fetch, store, slots, "agent-two", onOnePort());

    await expect((await fetch("/agent-one/client-config")).json()).resolves.toMatchObject({
      name: "agent-a",
    });
    await expect((await fetch("/agent-two/client-config")).json()).resolves.toMatchObject({
      name: "agent-b",
    });
  });

  test("answers 503 when the sandbox VM failed to start", async () => {
    const slots = createSlotCache();
    const { fetch, store } = await createTestOrchestrator({ slots });
    const broken: Sandbox = {
      ...fakeSandbox(),
      sessionUrl: () => Promise.reject(new Error("spawn failed")),
    };
    await seedResident(fetch, store, slots, "my-agent", broken);
    const res = await fetch("/my-agent/client-config");
    expect(res.status).toBe(503);
  });
});

describe("handleAgentPage", () => {
  test("returns 404 when no client HTML", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/no-agent/");
    expect(res.status).toBe(404);
  });

  test("serves HTML with CSP header for deployed agent", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
  });

  /**
   * The shell names content-hashed assets that only resolve through the
   * CURRENT agents row, so a cached one 404s its entry script after the next
   * deploy — and there is no stale-build reload on this surface to recover.
   * `no-store` rather than nothing at all: absent a directive and a validator,
   * a heuristically caching intermediary may reuse the response.
   */
  test("the shell is no-store, while its hashed assets stay immutable", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");

    const shell = await fetch("/my-agent/");
    expect(shell.headers.get("Cache-Control")).toBe("no-store");

    const asset = await fetch("/my-agent/assets/index.js");
    expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  test("the default-client fallback shell is no-store too", async () => {
    const { fetch } = await createTestOrchestrator();
    // An agent that shipped no client of its own falls back to aai-ui's
    // built default client — served from the container image, so a cached
    // shell outlives its assets across a rollout the same way.
    await deploy(fetch, { key: "key1", body: { slug: "bare-agent", clientFiles: {} } });

    const res = await fetch("/bare-agent/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});

describe("handleClientAsset", () => {
  test("returns 404 for missing asset", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/assets/missing.js");
    expect(res.status).toBe(404);
  });

  test("serves deployed asset with cache headers", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/assets/index.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Content-Type")).toContain("javascript");
    const body = await res.text();
    expect(body).toContain('console.log("c")');
  });

  test("rejects path with null bytes", async () => {
    const { fetch } = await createTestOrchestrator();
    await deployAgent(fetch, "my-agent");
    const res = await fetch("/my-agent/assets/index%00.js");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("Invalid asset path");
  });
});

// ── /:slug/websocket upgrade handling ───────────────────────────────────

type HarnessOpts = {
  /** Skip pre-populating the slot with the fake sandbox. Default: seeded. */
  seedSandbox?: boolean;
};

async function startServerWithOrchestrator(opts: HarnessOpts = {}): Promise<{
  port: number;
  server: http.Server;
  slug: string;
  slots: ReturnType<typeof createSlotCache>;
  store: ReturnType<typeof createTestStore>;
  sandbox: Sandbox;
  close: () => Promise<void>;
}> {
  const slug = "ws-agent";
  const slots = createSlotCache();
  const sandbox = fakeSandbox();
  // Pre-populate the slot with a fake sandbox so nothing spawns for real —
  // at version 1, matching the single putAgent below, so the resident is
  // not retired as superseded.
  if (opts.seedSandbox !== false) {
    setSlot(slots, { slug, sandbox, version: 1 });
  }
  const store = createTestStore();
  await store.putAgent({
    slug,
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: ["h"],
  });

  const { injectWebSocket } = createOrchestrator({ slots, store });
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  injectWebSocket(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        server,
        slug,
        slots,
        store,
        sandbox,
        // No upgrade ever completes into a session (every answer is a
        // handshake response), so closing the HTTP server is the whole
        // teardown.
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * Perform a raw HTTP/1.1 WebSocket upgrade and return everything the server
 * wrote before closing the socket. Lets tests read the handshake status line
 * (302/404/503/500) that a WebSocket client would only surface as "error".
 */
function rawUpgrade(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          `Sec-WebSocket-Version: 13\r\n${extra}\r\n`,
      );
    });
    let data = "";
    sock.on("data", (chunk) => {
      data += chunk.toString();
    });
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error("rawUpgrade timeout"));
    });
  });
}

function wsError(ws: WsClient): Promise<Error> {
  return new Promise((resolve) => {
    ws.on("error", (err) => resolve(err));
  });
}

describe("session upgrades (direct-to-tunnel)", () => {
  test("an upgrade is redirected to the sandbox's live session URL, not a session", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket`);
      expect(response).toMatch(/^HTTP\/1\.1 302 Found/);
      // `https:`, not `wss:` — see `httpScheme` in orchestrator-ws.ts. Same
      // target; the scheme is what the proxy in front of us can follow.
      expect(response).toContain("Location: https://tunnel.test/websocket");
      expect(response).toContain(`/${ctx.slug}/client-config`);
      // The long-living endpoint resolves the sandbox like the broker does.
      expect(ctx.sandbox.sessionUrl).toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });

  test("the redirect preserves the caller's query (sessionId resume)", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket?sessionId=abc123`);
      expect(response).toMatch(/^HTTP\/1\.1 302 Found/);
      expect(response).toContain("Location: https://tunnel.test/websocket?sessionId=abc123");
    } finally {
      await ctx.close();
    }
  });

  /**
   * The production crash this scheme rewrite exists for: Modal proxies a WebSocket
   * upgrade through aiohttp, which REFUSES a redirect to a non-HTTP scheme
   * (`NonHttpUrlRedirectClientError`) from inside `_proxy_websocket_request` —
   * a Python traceback in the app log and the container's input torn down, over a
   * session that had done nothing wrong.
   *
   * Asserted as the ABSENCE of `wss:` in the header rather than only as the
   * presence of `https:`, because the two tests above would both pass on a
   * `Location` that carried both (a rewrite that appended instead of replacing).
   */
  test("the redirect Location never carries a scheme an HTTP proxy cannot follow", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket`);
      const location = /^Location: (.*)$/m.exec(response)?.[1]?.trim();
      expect(location).toBeDefined();
      expect(location).toMatch(/^https:\/\//);
      expect(location).not.toContain("wss:");
      // The host and path are untouched — the rewrite must not point a client
      // somewhere else in the course of fixing the scheme.
      expect(new URL(String(location)).host).toBe("tunnel.test");
      expect(new URL(String(location)).pathname).toBe("/websocket");
    } finally {
      await ctx.close();
    }
  });

  test("an unknown slug is answered 404 with broker guidance", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const response = await rawUpgrade(ctx.port, "/no-such-agent/websocket");
      expect(response).toMatch(/^HTTP\/1\.1 404 Not Found/);
      expect(response).toContain("/no-such-agent/client-config");
      expect(response).not.toContain("Location:");
    } finally {
      await ctx.close();
    }
  });

  test("a sandbox that failed to start is answered 503 (retryable)", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      vi.mocked(ctx.sandbox.sessionUrl).mockImplementation(() =>
        Promise.reject(new Error("spawn failed")),
      );
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket`);
      expect(response).toMatch(/^HTTP\/1\.1 503 Service Unavailable/);
      expect(response).not.toContain("Location:");
    } finally {
      await ctx.close();
    }
  });

  test("a store failure during an upgrade answers 500 and destroys the socket", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await startServerWithOrchestrator({ seedSandbox: false });
    ctx.store.getAgent = () => Promise.reject(new Error("storage down"));
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket`);
      expect(response).toMatch(/^HTTP\/1\.1 500 Internal Server Error/);
    } finally {
      await ctx.close();
    }
  });

  test("upgrade for a non-slug path destroys the socket promptly", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const ws = new WsClient(`ws://127.0.0.1:${ctx.port}/not/a/slug/path`);
      // The server destroys the raw socket without completing the handshake;
      // the client surfaces that as an error, not an open.
      const err = await wsError(ws);
      expect(err).toBeInstanceOf(Error);
      expect(ws.readyState).not.toBe(WsClient.OPEN);
    } finally {
      await ctx.close();
    }
  });
});
