// Copyright 2025 the AAI authors. MIT license.
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { createMemoryChatStore } from "./chat-store.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createMemorySlugEpochs } from "./platform-epoch.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import { hashApiKey } from "./secrets.ts";
import {
  createTestOrchestrator,
  createTestStore,
  deployAgent,
  TEST_AGENT_CONFIG,
} from "./test-utils.ts";
import { createMemoryWorkspaceStore } from "./workspace-store.ts";

// Partial mock: the real guardHostModeUpgrade/wantsHostMode gate runs (that
// wiring is what these tests cover), but startDeployedHostSession is a spy —
// the real one would open a live provider session in-process.
const hostSessionSpy = vi.hoisted(() => vi.fn());
vi.mock("./ws-host-mode.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./ws-host-mode.ts")>();
  return { ...orig, startDeployedHostSession: hostSessionSpy };
});

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
    const slugEpochs = createMemorySlugEpochs();
    const { fetch } = await createTestOrchestrator({ slots, slugEpochs });
    await deployAgent(fetch, "my-agent");
    // Seed AFTER deploying (the deploy replaces the slug's slot), at the
    // deploy's epoch so the resident isn't invalidated as stale.
    slots.claim("my-agent", {
      slug: "my-agent",
      sandbox: makeFakeSandbox(),
      epoch: await slugEpochs.get("my-agent"),
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
    const slugEpochs = createMemorySlugEpochs();
    const { fetch } = await createTestOrchestrator({ slots, slugEpochs });
    await deployAgent(fetch, "my-agent");
    const broken: Sandbox = {
      ...makeFakeSandbox(),
      sessionUrl: () => Promise.reject(new Error("spawn failed")),
    };
    slots.claim("my-agent", {
      slug: "my-agent",
      sandbox: broken,
      epoch: await slugEpochs.get("my-agent"),
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

// ── WS lifecycle metrics ────────────────────────────────────────────────

/** Fake Sandbox (the direct-to-tunnel control-channel shape). */
function makeFakeSandbox(): Sandbox {
  return {
    sessionUrl: vi.fn(() => Promise.resolve("wss://tunnel.test:443/websocket")),
    activeSessions: vi.fn(() => Promise.resolve(0)),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

type HarnessOpts = {
  /** Cap for concurrent WS connections (injected into the orchestrator). */
  maxConnections?: number;
  /** When set, the stored credential hash really verifies this API key. */
  ownerKey?: string;
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
  activeSessionCount: () => number;
  close: () => Promise<void>;
}> {
  const slug = "ws-agent";
  const slots = createSlotCache();
  const sandbox = makeFakeSandbox();
  // Pre-populate the slot with a fake sandbox so nothing spawns for real.
  if (opts.seedSandbox !== false) {
    slots.claim(slug, { slug, sandbox });
  }
  const store = createTestStore();
  // Seed an agent config so the host-mode path can load it.
  await store.putAgent({
    slug,
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: [opts.ownerKey ? await hashApiKey(opts.ownerKey) : "h"],
    agentConfig: TEST_AGENT_CONFIG,
  });

  const { injectWebSocket, activeSessionCount } = createOrchestrator({
    slots,
    store,
    workspaces: createMemoryWorkspaceStore(),
    chats: createMemoryChatStore(),
    ...(opts.maxConnections !== undefined && { maxConnections: opts.maxConnections }),
  });
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
        activeSessionCount,
        // Teardown must not return while a session is still unwinding. The
        // *server-side* WebSocket's `close` event fires independently of both
        // the client socket (`wsClosed(ws)` resolves before it) and
        // `server.close()` — an upgraded socket is no longer a tracked HTTP
        // connection. Waiting for the live-session count to hit zero is the
        // observable form of "no teardown is in flight".
        close: async () => {
          await vi.waitFor(() => {
            const active = activeSessionCount();
            // A throw, not expect(): this runs outside a test body.
            if (active !== 0) {
              throw new Error(`session teardown pending: active=${active}`);
            }
          });
          await new Promise<void>((r) => {
            server.close(() => r());
          });
        },
      });
    });
  });
}

/**
 * Perform a raw HTTP/1.1 WebSocket upgrade and return everything the server
 * wrote before closing the socket. Lets tests read the handshake status line
 * (401/403/500) that a WebSocket client would only surface as "error".
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

function wsOpen(ws: WsClient): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });
}

function wsClosed(ws: WsClient): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function wsError(ws: WsClient): Promise<Error> {
  return new Promise((resolve) => {
    ws.on("error", (err) => resolve(err));
  });
}

describe("plain session upgrades (direct-to-tunnel)", () => {
  test("a plain upgrade is answered 410 with broker guidance, not a session", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket`);
      expect(response).toMatch(/^HTTP\/1\.1 410 Gone/);
      expect(response).toContain(`/${ctx.slug}/client-config`);
      // The sandbox is never consulted: clients dial its tunnel directly.
      expect(ctx.sandbox.sessionUrl).not.toHaveBeenCalled();
      expect(ctx.activeSessionCount()).toBe(0);
    } finally {
      await ctx.close();
    }
  });
});

// ── Host-mode (?host=1) upgrade wiring ──────────────────────────────────

describe("host-mode upgrade wiring", () => {
  beforeEach(() => {
    hostSessionSpy.mockClear();
  });

  test("host=1 without Authorization is answered 401 and never starts a session", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket?host=1`);
      expect(response).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
      expect(response).toContain("Authorization: Bearer");
      expect(hostSessionSpy).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });

  test("host=1 with a non-owner bearer is answered 403", async () => {
    const ctx = await startServerWithOrchestrator({ ownerKey: "owner-key" });
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket?host=1`, {
        Authorization: "Bearer wrong-key",
      });
      expect(response).toMatch(/^HTTP\/1\.1 403 Forbidden/);
      expect(hostSessionSpy).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });

  test("host=1 with the owner's key runs the host session path, not the sandbox", async () => {
    const ctx = await startServerWithOrchestrator({ ownerKey: "owner-key" });
    try {
      const ws = new WsClient(`ws://127.0.0.1:${ctx.port}/${ctx.slug}/websocket?host=1`, {
        headers: { Authorization: "Bearer owner-key" },
      });
      await wsOpen(ws);
      await vi.waitFor(() => {
        expect(hostSessionSpy).toHaveBeenCalledTimes(1);
      });
      expect(hostSessionSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          slug: ctx.slug,
          agentConfig: expect.objectContaining({ name: TEST_AGENT_CONFIG.name }),
        }),
      );
      // The deployed agent's sandbox is never touched by a host session.
      ws.close(1000);
      await wsClosed(ws);
    } finally {
      await ctx.close();
    }
  });

  test("host=1 needs no sandbox and no worker code — config + env suffice", async () => {
    // No resident sandbox, and no worker bundle either: a host session runs
    // in the server process, so the upgrade must not cold-spawn a sandbox or
    // fail on the missing worker.
    const ctx = await startServerWithOrchestrator({ ownerKey: "owner-key", seedSandbox: false });
    ctx.store.getWorkerCode = () => Promise.resolve(null);
    try {
      const ws = new WsClient(`ws://127.0.0.1:${ctx.port}/${ctx.slug}/websocket?host=1`, {
        headers: { Authorization: "Bearer owner-key" },
      });
      await wsOpen(ws);
      await vi.waitFor(() => {
        expect(hostSessionSpy).toHaveBeenCalledTimes(1);
      });
      // No slot was ever created: the sandbox path was never entered.
      expect(ctx.slots.get(ctx.slug)).toBeUndefined();
      ws.close(1000);
      await wsClosed(ws);
    } finally {
      await ctx.close();
    }
  });

  test("authorized host=1 with a missing agent config closes 1011, not a plain session", async () => {
    const ctx = await startServerWithOrchestrator({ ownerKey: "owner-key" });
    ctx.store.getAgentConfig = () => Promise.resolve(null);
    try {
      const ws = new WsClient(`ws://127.0.0.1:${ctx.port}/${ctx.slug}/websocket?host=1`, {
        headers: { Authorization: "Bearer owner-key" },
      });
      const closed = await wsClosed(ws);
      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("agent unavailable");
      // The owner's overrides must not be silently dropped into a plain
      // sandbox session.
      expect(hostSessionSpy).not.toHaveBeenCalled();
    } finally {
      await ctx.close();
    }
  });
});

// ── Upgrade ↔ teardown races and refusal paths ──────────────────────────

describe("upgrade/teardown races", () => {
  beforeEach(() => {
    hostSessionSpy.mockClear();
  });

  test("a store failure during a host=1 upgrade answers 500 and destroys the socket", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await startServerWithOrchestrator();
    ctx.store.getManifest = () => Promise.reject(new Error("storage down"));
    try {
      const response = await rawUpgrade(ctx.port, `/${ctx.slug}/websocket?host=1`, {
        Authorization: "Bearer any-key",
      });
      expect(response).toMatch(/^HTTP\/1\.1 500 Internal Server Error/);
    } finally {
      await ctx.close();
      errorSpy.mockRestore();
    }
  });

  test("upgrade for an unknown slug destroys the socket promptly", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const ws = new WsClient(`ws://127.0.0.1:${ctx.port}/nonexistent-slug/websocket`);
      // The server destroys the raw socket without completing the handshake;
      // the client surfaces that as an error, not an open.
      const err = await wsError(ws);
      expect(err).toBeInstanceOf(Error);
      expect(ws.readyState).not.toBe(WsClient.OPEN);
    } finally {
      await ctx.close();
    }
  });

  test("connections over maxConnections are refused; the slot frees on close", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = await startServerWithOrchestrator({ maxConnections: 1, ownerKey: "owner-key" });
    const hostWs = (path = `/${ctx.slug}/websocket?host=1`) =>
      new WsClient(`ws://127.0.0.1:${ctx.port}${path}`, {
        headers: { Authorization: "Bearer owner-key" },
      });
    try {
      const first = hostWs();
      await wsOpen(first);
      await vi.waitFor(() => {
        expect(ctx.activeSessionCount()).toBe(1);
      });

      // At capacity: the next upgrade's socket is destroyed pre-handshake.
      const refused = hostWs();
      const err = await wsError(refused);
      expect(err).toBeInstanceOf(Error);

      first.close(1000);
      await wsClosed(first);
      await vi.waitFor(() => {
        expect(ctx.activeSessionCount()).toBe(0);
      });

      // Closing the first connection released its slot: a new one succeeds.
      const third = hostWs();
      await wsOpen(third);
      third.close(1000);
      await wsClosed(third);
      await vi.waitFor(() => {
        expect(ctx.activeSessionCount()).toBe(0);
      });
    } finally {
      await ctx.close();
      warnSpy.mockRestore();
    }
  });
});
