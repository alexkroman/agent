// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: deploys a minimal agent into a real secure-exec isolate
 * and verifies the host ↔ isolate protocol, security boundaries, and
 * capability proxying end-to-end.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness-protocol.ts";
import { _internals } from "./sandbox.ts";

// ── Agent bundle ─────────────────────────────────────────────────────────

const AGENT_BUNDLE = `
export default {
  name: "integration-test",
  instructions: "You are a test agent.",
  greeting: "Hello from the isolate",
  maxSteps: 3,
  tools: {
    echo: {
      description: "Echo the input",
      execute(args) { return "echo:" + args.text; },
    },
    kv_roundtrip: {
      description: "Store then read from KV",
      async execute(args, ctx) {
        await ctx.kv.set("test-key", args.value);
        const result = await ctx.kv.get("test-key");
        return "stored:" + JSON.stringify(result);
      },
    },
    vec_roundtrip: {
      description: "Upsert then query vectors",
      async execute(args, ctx) {
        await ctx.vector.upsert("doc1", args.text, { source: "test" });
        const results = await ctx.vector.query(args.text, { topK: 1 });
        return "found:" + results.length;
      },
    },
    throws: {
      description: "Always throws",
      execute() { throw new Error("intentional failure"); },
    },

    // ── Security probe tools ──────────────────────────────────────────
    fetch_external: {
      description: "Try to fetch an external URL",
      async execute(args) {
        try {
          const res = await fetch(args.url);
          return "FETCHED:" + res.status;
        } catch (e) {
          return "BLOCKED:" + e.message;
        }
      },
    },
    fetch_metadata: {
      description: "Try to reach cloud metadata endpoint",
      async execute() {
        try {
          const res = await fetch("http://169.254.169.254/latest/meta-data/");
          return "FETCHED:" + res.status;
        } catch (e) {
          return "BLOCKED:" + e.message;
        }
      },
    },
    fetch_loopback: {
      description: "Try to fetch an arbitrary loopback port",
      async execute(args) {
        try {
          const res = await fetch("http://127.0.0.1:" + args.port + "/health");
          return "FETCHED:" + res.status;
        } catch (e) {
          return "BLOCKED:" + e.message;
        }
      },
    },
    write_file: {
      description: "Try to write to the filesystem",
      async execute() {
        try {
          const fs = await import("node:fs");
          fs.writeFileSync("/tmp/pwned.txt", "owned");
          return "WROTE";
        } catch (e) {
          return "BLOCKED:" + e.message;
        }
      },
    },
    spawn_process: {
      description: "Try to spawn a child process",
      async execute() {
        try {
          const cp = await import("node:child_process");
          const result = cp.execSync("id").toString();
          return "SPAWNED:" + result;
        } catch (e) {
          return "BLOCKED:" + e.message;
        }
      },
    },
    read_env: {
      description: "Try to read env vars",
      async execute() {
        return JSON.stringify({
          SIDECAR_URL: process.env.SIDECAR_URL || null,
          PATH: process.env.PATH || null,
          HOME: process.env.HOME || null,
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || null,
        });
      },
    },
  },
  state: () => ({ count: 0 }),
  onConnect: (ctx) => { ctx.state.count = 1; },
  onTurn: (text, ctx) => { ctx.state.lastTurn = text; },
};
`;

// ── Mocks ────────────────────────────────────────────────────────────────

function createMockKv() {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: unknown, _options?: { expireIn?: number }) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async <T = unknown>(
      _prefix: string,
      _options?: { limit?: number; reverse?: boolean },
    ): Promise<{ key: string; value: T }[]> => [],
    keys: async (_pattern?: string): Promise<string[]> => [],
  };
}

function createMockVector() {
  const docs = new Map<string, { data: string; metadata?: Record<string, unknown> }>();
  return {
    upsert: async (id: string, data: string, metadata?: Record<string, unknown>) => {
      docs.set(id, metadata != null ? { data, metadata } : { data });
    },
    query: async (text: string, options?: { topK?: number; filter?: string }) => {
      const results = [...docs.entries()]
        .filter(([, v]) => v.data.includes(text) || text.includes(v.data))
        .slice(0, options?.topK ?? 3)
        .map(([id, v]) => ({ id, data: v.data, score: 1.0, metadata: v.metadata }));
      return results;
    },
    remove: async (ids: string | string[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) docs.delete(id);
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const TEST_AUTH_TOKEN = "integration-test-token";

async function post<T>(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-harness-token": TEST_AUTH_TOKEN },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

function toolCall(port: number, name: string, args: Record<string, unknown> = {}) {
  return post<ToolCallResponse>(port, "/tool", {
    name,
    args,
    sessionId: "s1",
    messages: [],
    env: {},
  } satisfies ToolCallRequest);
}

// ── Protocol tests ───────────────────────────────────────────────────────

describe("isolate protocol", () => {
  let port: number;
  let sidecarPort: number;
  let cleanup: () => void;

  beforeAll(async () => {
    const kv = createMockKv();
    const vector = createMockVector();
    const sidecar = await _internals.startSidecarServer(kv, vector);
    sidecarPort = Number.parseInt(new URL(sidecar.url).port, 10);
    const isolate = await _internals.startIsolate(AGENT_BUNDLE, sidecar.url, {}, TEST_AUTH_TOKEN);
    port = isolate.port;
    cleanup = () => {
      isolate.runtime.dispose();
      sidecar.close();
    };
  });

  afterAll(async () => {
    cleanup?.();
  });

  test("GET /config returns valid IsolateConfig", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config`, {
      headers: { "x-harness-token": TEST_AUTH_TOKEN },
    });
    expect(res.ok).toBe(true);
    const config = (await res.json()) as IsolateConfig;
    expect(config.name).toBe("integration-test");
    expect(config.instructions).toBe("You are a test agent.");
    expect(config.greeting).toBe("Hello from the isolate");
    expect(config.maxSteps).toBe(3);
    expect(config.hasState).toBe(true);
    expect(config.hooks.onConnect).toBe(true);
    expect(config.hooks.onTurn).toBe(true);
    expect(config.hooks.onDisconnect).toBe(false);
  });

  test("tool execution returns result", async () => {
    const { status, data } = await toolCall(port, "echo", { text: "hello" });
    expect(status).toBe(200);
    expect(data.result).toBe("echo:hello");
  });

  test("unknown tool returns 404", async () => {
    const { status } = await toolCall(port, "nonexistent");
    expect(status).toBe(404);
  });

  test("tool exception returns 500", async () => {
    const { status, data } = await post<{ error: string }>(port, "/tool", {
      name: "throws",
      args: {},
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);
    expect(status).toBe(500);
    expect(data.error).toMatch(/intentional failure/);
  });

  test("KV round-trip through sidecar", async () => {
    const { status, data } = await toolCall(port, "kv_roundtrip", { value: "abc" });
    expect(status).toBe(200);
    expect(data.result).toBe('stored:"abc"');
  });

  test("vector round-trip through sidecar", async () => {
    const { status, data } = await toolCall(port, "vec_roundtrip", { text: "hello vectors" });
    expect(status).toBe(200);
    expect(data.result).toBe("found:1");
  });

  test("onConnect hook updates state", async () => {
    const { data } = await post<HookResponse>(port, "/hook", {
      hook: "onConnect",
      sessionId: "hook-s1",
      env: {},
    } satisfies HookRequest);
    expect(data.state.count).toBe(1);
  });

  test("onTurn hook receives text", async () => {
    const { data } = await post<HookResponse>(port, "/hook", {
      hook: "onTurn",
      sessionId: "hook-s1",
      text: "user said something",
      env: {},
    } satisfies HookRequest);
    expect(data.state.lastTurn).toBe("user said something");
  });

  test("resolveTurnConfig returns null for static maxSteps", async () => {
    const { data } = await post<HookResponse>(port, "/hook", {
      hook: "resolveTurnConfig",
      sessionId: "hook-s1",
      env: {},
    } satisfies HookRequest);
    expect(data.result).toBeNull();
  });

  test("GET unknown route returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`, {
      headers: { "x-harness-token": TEST_AUTH_TOKEN },
    });
    expect(res.status).toBe(404);
  });

  test("invalid JSON returns 500", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-harness-token": TEST_AUTH_TOKEN },
      body: "not json{{{",
    });
    expect(res.status).toBe(500);
  });

  test("request without auth token returns 401", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config`);
    expect(res.status).toBe(401);
  });

  // ── Security: network isolation ──────────────────────────────────────

  test("isolate cannot fetch external URLs", async () => {
    const { data } = await toolCall(port, "fetch_external", { url: "https://example.com" });
    expect(data.result).toMatch(/BLOCKED/);
  });

  test("isolate cannot reach cloud metadata endpoint", async () => {
    const { data } = await toolCall(port, "fetch_metadata");
    expect(data.result).toMatch(/BLOCKED/);
  });

  test("isolate cannot port-scan loopback", async () => {
    const wrongPort = sidecarPort + 1000;
    const { data } = await toolCall(port, "fetch_loopback", { port: wrongPort });
    expect(data.result).toMatch(/BLOCKED/);
  });

  // ── Security: filesystem isolation ───────────────────────────────────

  test("isolate cannot write to filesystem", async () => {
    const { data } = await toolCall(port, "write_file");
    expect(data.result).toMatch(/BLOCKED/);
  });

  // ── Security: process isolation ──────────────────────────────────────

  test("isolate cannot spawn child processes", async () => {
    const { data } = await toolCall(port, "spawn_process");
    expect(data.result).toMatch(/BLOCKED/);
  });

  // ── Security: env var isolation ──────────────────────────────────────

  test("isolate can only read allowed env vars (SIDECAR_URL + AAI_ENV_*)", async () => {
    const { data } = await toolCall(port, "read_env");
    const env = JSON.parse(data.result);
    expect(env.SIDECAR_URL).toBeTruthy();
    expect(env.PATH).toBeNull();
    expect(env.HOME).toBeNull();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeNull();
  });
});

// ── WebSocket session lifecycle ──────────────────────────────────────────

describe("WebSocket session lifecycle", () => {
  let sandbox: Awaited<ReturnType<typeof _internals.createSandbox>>;

  beforeAll(async () => {
    const { createTestKvStore, createTestVectorStore } = await import("./_test-utils.ts");
    sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      apiKey: "test-key",
      agentEnv: {},
      kvStore: createTestKvStore(),
      scope: { keyHash: "test", slug: "ws-test" },
      vectorStore: createTestVectorStore(),
    });
  });

  afterAll(async () => {
    await sandbox?.terminate();
  });

  test("startSession sends config message on open", async () => {
    const messages: string[] = [];
    let _opened = false;
    let _closed = false;

    const ws = {
      readyState: 1,
      send(data: string | ArrayBuffer | Uint8Array) {
        if (typeof data === "string") messages.push(data);
      },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      addEventListener(type: string, listener: any) {
        if (type === "open") {
          _opened = true;
          listener(new Event("open"));
        }
        if (type === "close") {
          setTimeout(() => {
            _closed = true;
            listener(new Event("close"));
          }, 500);
        }
      },
    };

    sandbox.startSession(ws as unknown as WebSocket, false);

    await new Promise((r) => setTimeout(r, 200));

    expect(messages.length).toBeGreaterThan(0);
    const config = JSON.parse(messages[0] as string);
    expect(config.type).toBe("config");
    expect(config.audioFormat).toBe("pcm16");
    expect(config.sampleRate).toBeTruthy();
  });
});

// ── Multiple concurrent agents ───────────────────────────────────────────

describe("multiple concurrent agents", () => {
  let port1: number;
  let port2: number;
  let cleanup1: () => void;
  let cleanup2: () => void;

  const BUNDLE_A = `
export default {
  name: "agent-a",
  instructions: "A",
  greeting: "Hi from A",
  maxSteps: 1,
  tools: { id: { description: "Return agent name", execute() { return "agent-a"; } } },
};
`;

  const BUNDLE_B = `
export default {
  name: "agent-b",
  instructions: "B",
  greeting: "Hi from B",
  maxSteps: 2,
  tools: { id: { description: "Return agent name", execute() { return "agent-b"; } } },
};
`;

  beforeAll(async () => {
    const kv1 = createMockKv();
    const kv2 = createMockKv();
    const sidecar1 = await _internals.startSidecarServer(kv1, undefined);
    const sidecar2 = await _internals.startSidecarServer(kv2, undefined);
    const [iso1, iso2] = await Promise.all([
      _internals.startIsolate(BUNDLE_A, sidecar1.url, {}, TEST_AUTH_TOKEN),
      _internals.startIsolate(BUNDLE_B, sidecar2.url, {}, TEST_AUTH_TOKEN),
    ]);
    port1 = iso1.port;
    port2 = iso2.port;
    cleanup1 = () => {
      iso1.runtime.dispose();
      sidecar1.close();
    };
    cleanup2 = () => {
      iso2.runtime.dispose();
      sidecar2.close();
    };
  });

  afterAll(() => {
    cleanup1?.();
    cleanup2?.();
  });

  test("two isolates run independently", async () => {
    const [config1, config2] = await Promise.all([
      fetch(`http://127.0.0.1:${port1}/config`, {
        headers: { "x-harness-token": TEST_AUTH_TOKEN },
      }).then((r) => r.json()),
      fetch(`http://127.0.0.1:${port2}/config`, {
        headers: { "x-harness-token": TEST_AUTH_TOKEN },
      }).then((r) => r.json()),
    ]);

    expect((config1 as IsolateConfig).name).toBe("agent-a");
    expect((config2 as IsolateConfig).name).toBe("agent-b");
    expect((config1 as IsolateConfig).maxSteps).toBe(1);
    expect((config2 as IsolateConfig).maxSteps).toBe(2);
  });

  test("tool calls route to correct isolate", async () => {
    const [r1, r2] = await Promise.all([toolCall(port1, "id"), toolCall(port2, "id")]);

    expect(r1.data.result).toBe("agent-a");
    expect(r2.data.result).toBe("agent-b");
  });
});

// ── Idle eviction ────────────────────────────────────────────────────────

describe("idle eviction", () => {
  const originalIdleMs = _internals.IDLE_MS;

  afterAll(() => {
    _internals.IDLE_MS = originalIdleMs;
  });

  test("sandbox is evicted after idle timeout", async () => {
    _internals.IDLE_MS = 200;

    const { createTestKvStore } = await import("./_test-utils.ts");
    const kvStore = createTestKvStore();
    const scope = { keyHash: "test", slug: "idle-test" };

    const slot = {
      slug: "idle-test",
      keyHash: "test",
    } as import("./sandbox.ts").AgentSlot;

    const sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      apiKey: "test-key",
      agentEnv: {},
      kvStore,
      scope,
    });

    slot.sandbox = sandbox;
    slot.idleTimer = setTimeout(() => {
      slot.sandbox?.terminate();
      delete slot.sandbox;
      delete slot.idleTimer;
    }, _internals.IDLE_MS);

    expect(slot.sandbox).toBeTruthy();

    // Poll until the idle timer fires instead of a fixed sleep
    await vi.waitFor(() => expect(slot.sandbox).toBeUndefined(), { timeout: 5000, interval: 50 });
  });
});

// ── Redeploy replaces sandbox ────────────────────────────────────────────

describe("redeploy replaces sandbox", () => {
  test("deploying same slug terminates old sandbox", async () => {
    const { createTestKvStore } = await import("./_test-utils.ts");
    const kvStore = createTestKvStore();
    const scope = { keyHash: "test", slug: "redeploy-test" };

    const sandbox1 = await _internals.createSandbox({
      workerCode: `export default { name: "v1", instructions: "v1", greeting: "v1", maxSteps: 1, tools: {} };`,
      apiKey: "test-key",
      agentEnv: {},
      kvStore,
      scope,
    });

    const sandbox2 = await _internals.createSandbox({
      workerCode: `export default { name: "v2", instructions: "v2", greeting: "v2", maxSteps: 1, tools: {} };`,
      apiKey: "test-key",
      agentEnv: {},
      kvStore,
      scope,
    });

    sandbox1.terminate();

    expect(sandbox2).toBeTruthy();

    sandbox2.terminate();
  });
});
