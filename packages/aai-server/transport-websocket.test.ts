// Copyright 2025 the AAI authors. MIT license.
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { createOrchestrator } from "./orchestrator.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import {
  createTestOrchestrator,
  createTestStore,
  deployAgent,
  TEST_AGENT_CONFIG,
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
  test("returns 404 for non-existent agent", async () => {
    const { fetch } = await createTestOrchestrator();
    const res = await fetch("/no-agent/client-config");
    expect(res.status).toBe(404);
  });

  test("brokers name, greeting, and the sandbox's live sessionUrl", async () => {
    // A resident fake sandbox: the broker must reuse it (resolveSandbox fast
    // path) rather than spawning a real one.
    const slots = createSlotCache();
    const { fetch, store } = await createTestOrchestrator({ slots });
    await deployAgent(fetch, "my-agent");
    // Seed AFTER deploying (the deploy replaces the slug's slot), at the
    // deploy's version so the resident isn't invalidated as stale.
    slots.claim("my-agent", {
      slug: "my-agent",
      sandbox: makeFakeSandbox(),
      version: (await store.getAgentVersion("my-agent")) ?? 1,
    });
    const res = await fetch("/my-agent/client-config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "test-agent",
      greeting: "",
      sessionUrl: "wss://tunnel.test:443/websocket",
    });
  });

  test("answers 503 when the sandbox VM failed to start", async () => {
    const slots = createSlotCache();
    const { fetch, store } = await createTestOrchestrator({ slots });
    await deployAgent(fetch, "my-agent");
    const broken: Sandbox = {
      ...makeFakeSandbox(),
      sessionUrl: () => Promise.reject(new Error("spawn failed")),
    };
    slots.claim("my-agent", {
      slug: "my-agent",
      sandbox: broken,
      version: (await store.getAgentVersion("my-agent")) ?? 1,
    });
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

/** Fake Sandbox (the direct-to-tunnel control-channel shape). */
function makeFakeSandbox(): Sandbox {
  return {
    sessionUrl: vi.fn(() => Promise.resolve("wss://tunnel.test:443/websocket")),
    activeSessions: vi.fn(() => Promise.resolve(0)),
    drain: vi.fn(() => Promise.resolve()),
    alive: vi.fn(() => true),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

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
  sandbox: ReturnType<typeof makeFakeSandbox>;
  close: () => Promise<void>;
}> {
  const slug = "ws-agent";
  const slots = createSlotCache();
  const sandbox = makeFakeSandbox();
  // Pre-populate the slot with a fake sandbox so nothing spawns for real —
  // at version 1, matching the single putAgent below, so the resident is
  // not retired as superseded.
  if (opts.seedSandbox !== false) {
    slots.claim(slug, { slug, sandbox, version: 1 });
  }
  const store = createTestStore();
  await store.putAgent({
    slug,
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: ["h"],
    agentConfig: TEST_AGENT_CONFIG,
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
      expect(response).toContain("Location: wss://tunnel.test/websocket");
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
      expect(response).toContain("Location: wss://tunnel.test/websocket?sessionId=abc123");
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
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await startServerWithOrchestrator({ seedSandbox: false });
    ctx.store.getAgent = () => Promise.reject(new Error("storage down"));
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket`);
      expect(response).toMatch(/^HTTP\/1\.1 500 Internal Server Error/);
    } finally {
      await ctx.close();
      errorSpy.mockRestore();
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
