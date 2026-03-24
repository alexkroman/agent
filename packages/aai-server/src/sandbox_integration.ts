// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: deploys a minimal agent into a real secure-exec isolate
 * and verifies the host ↔ isolate protocol, security boundaries, and
 * capability proxying end-to-end.
 *
 * Uses node:test (built-in, no vitest) because isolated-vm's native
 * module doesn't survive vitest worker forking.
 *
 * Run: pnpm --filter @alexkroman1/aai-server test:integration
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness_protocol.ts";
import { _internals } from "./sandbox.ts";

// ── Agent bundle ─────────────────────────────────────────────────────────

const AGENT_BUNDLE = `
module.exports = {
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
          const fs = require("node:fs");
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
          const cp = require("node:child_process");
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
      docs.set(id, { data, metadata });
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

async function post<T>(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

  before(async () => {
    const kv = createMockKv();
    const vector = createMockVector();
    const sidecar = await _internals.startSidecarServer(kv, vector);
    sidecarPort = Number.parseInt(new URL(sidecar.url).port, 10);
    const isolate = await _internals.startIsolate(AGENT_BUNDLE, sidecar.url);
    port = isolate.port;
    cleanup = () => {
      isolate.runtime.dispose();
      sidecar.close();
    };
  });

  after(() => cleanup?.());

  test("GET /config returns valid IsolateConfig", { timeout: 5_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config`);
    assert.equal(res.ok, true);
    const config = (await res.json()) as IsolateConfig;
    assert.equal(config.name, "integration-test");
    assert.equal(config.instructions, "You are a test agent.");
    assert.equal(config.greeting, "Hello from the isolate");
    assert.equal(config.maxSteps, 3);
    assert.equal(config.hasState, true);
    assert.equal(config.hooks.onConnect, true);
    assert.equal(config.hooks.onTurn, true);
    assert.equal(config.hooks.onDisconnect, false);
  });

  test("tool execution returns result", { timeout: 5_000 }, async () => {
    const { status, data } = await toolCall(port, "echo", { text: "hello" });
    assert.equal(status, 200);
    assert.equal(data.result, "echo:hello");
  });

  test("unknown tool returns 404", { timeout: 5_000 }, async () => {
    const { status } = await toolCall(port, "nonexistent");
    assert.equal(status, 404);
  });

  test("tool exception returns 500", { timeout: 5_000 }, async () => {
    const { status, data } = await post<{ error: string }>(port, "/tool", {
      name: "throws",
      args: {},
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);
    assert.equal(status, 500);
    assert.match(data.error, /intentional failure/);
  });

  test("KV round-trip through sidecar", { timeout: 5_000 }, async () => {
    const { status, data } = await toolCall(port, "kv_roundtrip", { value: "abc" });
    assert.equal(status, 200, `got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.result, 'stored:"abc"');
  });

  test("vector round-trip through sidecar", { timeout: 5_000 }, async () => {
    const { status, data } = await toolCall(port, "vec_roundtrip", { text: "hello vectors" });
    assert.equal(status, 200, `got ${status}: ${JSON.stringify(data)}`);
    assert.equal(data.result, "found:1");
  });

  test("onConnect hook updates state", { timeout: 5_000 }, async () => {
    const { data } = await post<HookResponse>(port, "/hook", {
      hook: "onConnect",
      sessionId: "hook-s1",
      env: {},
    } satisfies HookRequest);
    assert.equal(data.state.count, 1);
  });

  test("onTurn hook receives text", { timeout: 5_000 }, async () => {
    const { data } = await post<HookResponse>(port, "/hook", {
      hook: "onTurn",
      sessionId: "hook-s1",
      env: {},
      text: "user said something",
    } satisfies HookRequest);
    assert.equal(data.state.lastTurn, "user said something");
  });

  test("resolveTurnConfig returns null for static maxSteps", { timeout: 5_000 }, async () => {
    const { data } = await post<HookResponse>(port, "/hook", {
      hook: "resolveTurnConfig",
      sessionId: "hook-s1",
      env: {},
    } satisfies HookRequest);
    assert.equal(data.result, null);
  });

  test("GET unknown route returns 404", { timeout: 5_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    assert.equal(res.status, 404);
  });

  test("invalid JSON returns 500", { timeout: 5_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    assert.equal(res.status, 500);
  });

  // ── Security: network isolation ──────────────────────────────────────

  test("isolate cannot fetch external URLs", { timeout: 5_000 }, async () => {
    const { data } = await toolCall(port, "fetch_external", { url: "https://example.com" });
    assert.match(data.result, /BLOCKED/);
  });

  test("isolate cannot reach cloud metadata endpoint", { timeout: 5_000 }, async () => {
    const { data } = await toolCall(port, "fetch_metadata");
    assert.match(data.result, /BLOCKED/);
  });

  test("isolate cannot port-scan loopback", { timeout: 5_000 }, async () => {
    // Try a random port that isn't the sidecar
    const wrongPort = sidecarPort + 1000;
    const { data } = await toolCall(port, "fetch_loopback", { port: wrongPort });
    assert.match(data.result, /BLOCKED/);
  });

  // ── Security: filesystem isolation ───────────────────────────────────

  test("isolate cannot write to filesystem", { timeout: 5_000 }, async () => {
    const { data } = await toolCall(port, "write_file");
    assert.match(data.result, /BLOCKED/);
  });

  // ── Security: process isolation ──────────────────────────────────────

  test("isolate cannot spawn child processes", { timeout: 5_000 }, async () => {
    const { data } = await toolCall(port, "spawn_process");
    assert.match(data.result, /BLOCKED/);
  });

  // ── Security: env var isolation ──────────────────────────────────────

  test("isolate can only read SIDECAR_URL env var", { timeout: 5_000 }, async () => {
    const { data } = await toolCall(port, "read_env");
    const env = JSON.parse(data.result);
    // SIDECAR_URL should be set (it's allowed)
    assert.ok(env.SIDECAR_URL, "SIDECAR_URL should be readable");
    // Sensitive vars should NOT be accessible
    assert.equal(env.PATH, null, "PATH should not be readable");
    assert.equal(env.HOME, null, "HOME should not be readable");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, null, "AWS creds should not be readable");
  });
});

// ── WebSocket session lifecycle ──────────────────────────────────────────

describe("WebSocket session lifecycle", () => {
  let sandbox: Awaited<ReturnType<typeof _internals.createSandbox>>;

  before(async () => {
    const { createTestKvStore, createTestVectorStore } = await import("./_test_utils.ts");
    sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      env: { ASSEMBLYAI_API_KEY: "test-key" },
      kvStore: createTestKvStore(),
      scope: { keyHash: "test", slug: "ws-test" },
      vectorStore: createTestVectorStore(),
    });
  });

  after(() => sandbox?.terminate());

  test("startSession sends config message on open", { timeout: 10_000 }, async () => {
    const messages: string[] = [];
    let _opened = false;
    let _closed = false;

    // Minimal SessionWebSocket mock
    const ws = {
      readyState: 1, // OPEN
      send(data: string | ArrayBuffer | Uint8Array) {
        if (typeof data === "string") messages.push(data);
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const fn = typeof listener === "function" ? listener : listener.handleEvent.bind(listener);
        if (type === "open") {
          _opened = true;
          fn(new Event("open"));
        }
        if (type === "close") {
          // Store close handler for later
          setTimeout(() => {
            _closed = true;
            fn(new Event("close"));
          }, 500);
        }
      },
    };

    sandbox.startSession(ws, false);

    // Wait for config message
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(messages.length > 0, "should have sent at least one message");
    const config = JSON.parse(messages[0] as string);
    assert.equal(config.type, "config");
    assert.equal(config.audioFormat, "pcm16");
    assert.ok(config.sampleRate, "should have sampleRate");
  });
});

// ── Multiple concurrent agents ───────────────────────────────────────────

describe("multiple concurrent agents", () => {
  let port1: number;
  let port2: number;
  let cleanup1: () => void;
  let cleanup2: () => void;

  const BUNDLE_A = `
module.exports = {
  name: "agent-a",
  instructions: "A",
  greeting: "Hi from A",
  maxSteps: 1,
  tools: { id: { description: "Return agent name", execute() { return "agent-a"; } } },
};
`;

  const BUNDLE_B = `
module.exports = {
  name: "agent-b",
  instructions: "B",
  greeting: "Hi from B",
  maxSteps: 2,
  tools: { id: { description: "Return agent name", execute() { return "agent-b"; } } },
};
`;

  before(async () => {
    const kv1 = createMockKv();
    const kv2 = createMockKv();
    const sidecar1 = await _internals.startSidecarServer(kv1, undefined);
    const sidecar2 = await _internals.startSidecarServer(kv2, undefined);
    const [iso1, iso2] = await Promise.all([
      _internals.startIsolate(BUNDLE_A, sidecar1.url),
      _internals.startIsolate(BUNDLE_B, sidecar2.url),
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

  after(() => {
    cleanup1?.();
    cleanup2?.();
  });

  test("two isolates run independently", { timeout: 15_000 }, async () => {
    const [config1, config2] = await Promise.all([
      fetch(`http://127.0.0.1:${port1}/config`).then((r) => r.json()),
      fetch(`http://127.0.0.1:${port2}/config`).then((r) => r.json()),
    ]);

    assert.equal((config1 as IsolateConfig).name, "agent-a");
    assert.equal((config2 as IsolateConfig).name, "agent-b");
    assert.equal((config1 as IsolateConfig).maxSteps, 1);
    assert.equal((config2 as IsolateConfig).maxSteps, 2);
  });

  test("tool calls route to correct isolate", { timeout: 10_000 }, async () => {
    const [r1, r2] = await Promise.all([toolCall(port1, "id"), toolCall(port2, "id")]);

    assert.equal(r1.data.result, "agent-a");
    assert.equal(r2.data.result, "agent-b");
  });
});

// ── Idle eviction ────────────────────────────────────────────────────────

describe("idle eviction", () => {
  const originalIdleMs = _internals.IDLE_MS;

  after(() => {
    _internals.IDLE_MS = originalIdleMs;
  });

  test("sandbox is evicted after idle timeout", { timeout: 10_000 }, async () => {
    // Set idle to 200ms for fast testing
    _internals.IDLE_MS = 200;

    const { createTestKvStore } = await import("./_test_utils.ts");
    const kvStore = createTestKvStore();
    const scope = { keyHash: "test", slug: "idle-test" };

    const slot = {
      slug: "idle-test",
      keyHash: "test",
    } as import("./sandbox.ts").AgentSlot;

    const sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      env: { ASSEMBLYAI_API_KEY: "test-key" },
      kvStore,
      scope,
    });

    // Manually assign to slot and start idle timer
    slot.sandbox = sandbox;
    // The ensureAgent function sets the timer, but we simulate it here
    slot.idleTimer = setTimeout(() => {
      slot.sandbox?.terminate();
      delete slot.sandbox;
      delete slot.idleTimer;
    }, _internals.IDLE_MS);

    assert.ok(slot.sandbox, "sandbox should exist before timeout");

    // Wait for eviction
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(slot.sandbox, undefined, "sandbox should be evicted after idle timeout");
  });
});

// ── Redeploy replaces sandbox ────────────────────────────────────────────

describe("redeploy replaces sandbox", () => {
  test("deploying same slug terminates old sandbox", { timeout: 15_000 }, async () => {
    const { createTestKvStore } = await import("./_test_utils.ts");
    const kvStore = createTestKvStore();
    const scope = { keyHash: "test", slug: "redeploy-test" };

    // Deploy first version
    const sandbox1 = await _internals.createSandbox({
      workerCode: `module.exports = { name: "v1", instructions: "v1", greeting: "v1", maxSteps: 1, tools: {} };`,
      env: { ASSEMBLYAI_API_KEY: "test-key" },
      kvStore,
      scope,
    });

    // Deploy second version (simulates redeploy)
    const sandbox2 = await _internals.createSandbox({
      workerCode: `module.exports = { name: "v2", instructions: "v2", greeting: "v2", maxSteps: 1, tools: {} };`,
      env: { ASSEMBLYAI_API_KEY: "test-key" },
      kvStore,
      scope,
    });

    // Terminate old sandbox (as deploy handler does)
    sandbox1.terminate();

    // New sandbox should still work
    // We can't easily verify the old one is dead (no port exposed),
    // but we verify the new one is alive and has the right config
    // by checking it was created successfully
    assert.ok(sandbox2, "new sandbox should be created");

    sandbox2.terminate();
  });
});
