// Copyright 2025 the AAI authors. MIT license.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionWebSocket } from "@alexkroman1/aai/runtime";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registry } from "./metrics.ts";
import { createOrchestrator } from "./orchestrator.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache } from "./sandbox-slots.ts";
import {
  createTestOrchestrator,
  createTestStorage,
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

/** Fake Sandbox for WS lifecycle tests. Avoids spawning a real Deno child. */
function makeFakeSandbox(): Sandbox {
  return {
    readyConfig: { audioFormat: "pcm16", sampleRate: 16_000, ttsSampleRate: 24_000 },
    // accept the ws but don't actually wire a session — just register a no-op
    startSession: ((_ws: SessionWebSocket) => {
      // intentionally empty: we only care about orchestrator-level lifecycle
    }) as unknown as Sandbox["startSession"],
    shutdown: vi.fn(() => Promise.resolve()),
  } as unknown as Sandbox;
}

function counterValue(name: string, labels: Record<string, string>): number {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  const m = registry.getSingleMetric(name) as any;
  if (!m?.hashMap) return 0;
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  for (const entry of Object.values(m.hashMap) as any[]) {
    const ok = Object.entries(labels).every(([k, v]) => entry.labels?.[k] === v);
    if (ok) return entry.value ?? 0;
  }
  return 0;
}

function gaugeValue(name: string, labels: Record<string, string> = {}): number {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  const m = registry.getSingleMetric(name) as any;
  if (!m?.hashMap) return 0;
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  for (const entry of Object.values(m.hashMap) as any[]) {
    const ok = Object.entries(labels).every(([k, v]) => entry.labels?.[k] === v);
    if (ok) return entry.value ?? 0;
  }
  return 0;
}

function histogramCount(name: string): number {
  // biome-ignore lint/suspicious/noExplicitAny: prom-client internals not typed
  const m = registry.getSingleMetric(name) as any;
  // Unlabeled histograms have a single hashMap entry under "" with `count`.
  return m?.hashMap?.[""]?.count ?? 0;
}

async function startServerWithOrchestrator(): Promise<{
  port: number;
  server: http.Server;
  slug: string;
  close: () => Promise<void>;
}> {
  const slug = "metric-agent";
  const slots = createSlotCache();
  // Pre-populate the slot with a fake sandbox so resolveSandbox returns
  // it immediately without spawning a Deno child.
  slots.set(slug, {
    slug,
    keyHash: "test-hash",
    sandbox: makeFakeSandbox() as unknown as { shutdown(): Promise<void> },
  });
  const store = createTestStore();
  const storage = createTestStorage();
  // Seed an agent config so resolveUpgrade can read the mode label.
  await store.putAgent({
    slug,
    env: {},
    worker: "w",
    clientFiles: { "index.html": "<html></html>" },
    credential_hashes: ["h"],
    agentConfig: TEST_AGENT_CONFIG,
  });

  const { injectWebSocket } = createOrchestrator({ slots, store, storage });
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
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe("WS lifecycle metrics", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  afterEach(() => {
    registry.resetMetrics();
  });

  test("increments sessions_started and sessions_active on upgrade", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/${ctx.slug}/websocket`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });

      await vi.waitFor(() => {
        expect(
          counterValue("aai_sessions_started_total", { mode: "s2s", slug: "metric-agent" }),
        ).toBe(1);
        expect(gaugeValue("aai_sessions_active", { slug: "metric-agent" })).toBe(1);
      });

      ws.close(1000);
      await new Promise<void>((r) => ws.addEventListener("close", () => r()));
      // Wait for server-side close handler to fire before next test resets
      // metrics — otherwise a stale dec() can race with the next test's inc().
      await vi.waitFor(() => {
        expect(gaugeValue("aai_sessions_active", { slug: "metric-agent" })).toBe(0);
      });
    } finally {
      await ctx.close();
    }
  });

  test("on clean close: increments sessions_ended{client_close}, decrements active, observes duration", async () => {
    const ctx = await startServerWithOrchestrator();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/${ctx.slug}/websocket`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("ws error")));
      });
      // Wait for upgrade-side metrics to land so sessions_active is at 1.
      await vi.waitFor(() => {
        expect(gaugeValue("aai_sessions_active", { slug: "metric-agent" })).toBe(1);
      });

      ws.close(1000);
      await new Promise<void>((r) => ws.addEventListener("close", () => r()));

      await vi.waitFor(() => {
        // Client-initiated close with code 1000 → reason="client_close".
        expect(
          counterValue("aai_sessions_ended_total", {
            reason: "client_close",
            slug: "metric-agent",
          }),
        ).toBe(1);
        expect(gaugeValue("aai_sessions_active", { slug: "metric-agent" })).toBe(0);
        expect(histogramCount("aai_session_duration_seconds")).toBeGreaterThanOrEqual(1);
      });
    } finally {
      await ctx.close();
    }
  });
});
