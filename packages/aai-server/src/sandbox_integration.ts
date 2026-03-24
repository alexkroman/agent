// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: deploys a minimal agent into a real secure-exec isolate
 * and verifies the host ↔ isolate protocol end-to-end.
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

// ── Agent bundle with tools, hooks, state, and KV usage ─────────────────

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
    store_and_load: {
      description: "Store a value in KV then read it back",
      async execute(args, ctx) {
        await ctx.kv.set("test-key", args.value);
        const result = await ctx.kv.get("test-key");
        return "stored:" + JSON.stringify(result);
      },
    },
    vec_store_and_search: {
      description: "Upsert a vector then query it",
      async execute(args, ctx) {
        await ctx.vector.upsert("doc1", args.text, { source: "test" });
        const results = await ctx.vector.query(args.text, { topK: 1 });
        return "found:" + results.length;
      },
    },
    bad_tool: {
      description: "Always throws",
      execute() { throw new Error("intentional failure"); },
    },
  },
  state: () => ({ count: 0 }),
  onConnect: (ctx) => { ctx.state.count = 1; },
  onTurn: (text, ctx) => { ctx.state.lastTurn = text; },
};
`;

// ── Mock KV with real storage ────────────────────────────────────────────

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
      // Simple substring match for testing
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("isolate protocol", () => {
  let port: number;
  let cleanup: () => void;

  before(async () => {
    const kv = createMockKv();
    const vector = createMockVector();
    const sidecar = await _internals.startSidecarServer(kv, vector);
    const isolate = await _internals.startIsolate(AGENT_BUNDLE, sidecar.url);
    port = isolate.port;
    cleanup = () => {
      isolate.runtime.dispose();
      sidecar.close();
    };
  });

  after(() => cleanup?.());

  // ── GET /config ──────────────────────────────────────────────────────

  test("GET /config returns valid IsolateConfig", { timeout: 5_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config`);
    assert.equal(res.ok, true);

    const config = (await res.json()) as IsolateConfig;
    assert.equal(config.name, "integration-test");
    assert.equal(config.instructions, "You are a test agent.");
    assert.equal(config.greeting, "Hello from the isolate");
    assert.equal(config.maxSteps, 3);
    assert.equal(config.hasState, true);

    // Hooks
    assert.equal(config.hooks.onConnect, true);
    assert.equal(config.hooks.onTurn, true);
    assert.equal(config.hooks.onDisconnect, false);
    assert.equal(config.hooks.onError, false);
    assert.equal(config.hooks.maxStepsIsFn, false);

    // Tool schemas
    assert.equal(config.toolSchemas.length, 4);
    const echo = config.toolSchemas.find((t) => t.name === "echo");
    assert.ok(echo, "echo tool schema missing");
    assert.equal(echo.description, "Echo the input");
  });

  // ── POST /tool ───────────────────────────────────────────────────────

  test("POST /tool executes tool and returns result", { timeout: 5_000 }, async () => {
    const { status, data } = await post<ToolCallResponse>(port, "/tool", {
      name: "echo",
      args: { text: "hello world" },
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);

    assert.equal(status, 200);
    assert.equal(data.result, "echo:hello world");
    assert.ok(data.state, "state should be returned");
  });

  test("POST /tool returns 404 for unknown tool", { timeout: 5_000 }, async () => {
    const { status } = await post(port, "/tool", {
      name: "nonexistent",
      args: {},
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);

    assert.equal(status, 404);
  });

  test("POST /tool returns 500 when tool throws", { timeout: 5_000 }, async () => {
    const { status, data } = await post<{ error: string }>(port, "/tool", {
      name: "bad_tool",
      args: {},
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);

    assert.equal(status, 500);
    assert.match(data.error, /intentional failure/);
  });

  // ── POST /tool with KV round-trip ────────────────────────────────────

  test("tool can set and get from KV via sidecar", { timeout: 5_000 }, async () => {
    const { status, data } = await post<ToolCallResponse | { error: string }>(port, "/tool", {
      name: "store_and_load",
      args: { value: "test-value-123" },
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert.equal((data as ToolCallResponse).result, 'stored:"test-value-123"');
  });

  // ── POST /tool with vector round-trip ──────────────────────────────────

  test("tool can upsert and query vectors via sidecar", { timeout: 5_000 }, async () => {
    const { status, data } = await post<ToolCallResponse | { error: string }>(port, "/tool", {
      name: "vec_store_and_search",
      args: { text: "hello vectors" },
      sessionId: "s1",
      messages: [],
      env: {},
    } satisfies ToolCallRequest);

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert.equal((data as ToolCallResponse).result, "found:1");
  });

  // ── POST /hook ───────────────────────────────────────────────────────

  test("POST /hook invokes onConnect and updates state", { timeout: 5_000 }, async () => {
    const { status, data } = await post<HookResponse>(port, "/hook", {
      hook: "onConnect",
      sessionId: "hook-s1",
      env: {},
    } satisfies HookRequest);

    assert.equal(status, 200);
    assert.equal(data.state.count, 1);
  });

  test("POST /hook invokes onTurn with text", { timeout: 5_000 }, async () => {
    const { status, data } = await post<HookResponse>(port, "/hook", {
      hook: "onTurn",
      sessionId: "hook-s1",
      env: {},
      text: "user said something",
    } satisfies HookRequest);

    assert.equal(status, 200);
    assert.equal(data.state.lastTurn, "user said something");
  });

  test("POST /hook resolveTurnConfig returns null for static maxSteps", {
    timeout: 5_000,
  }, async () => {
    const { status, data } = await post<HookResponse>(port, "/hook", {
      hook: "resolveTurnConfig",
      sessionId: "hook-s1",
      env: {},
    } satisfies HookRequest);

    assert.equal(status, 200);
    assert.equal(data.result, null);
  });

  // ── Error paths ──────────────────────────────────────────────────────

  test("GET /nonexistent returns 404", { timeout: 5_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
    assert.equal(res.status, 404);
  });

  test("POST /tool with invalid JSON returns 500", { timeout: 5_000 }, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{{{",
    });
    assert.equal(res.status, 500);
  });
});

// TODO: Test invalid bundle handling once startIsolate supports timeouts.
// Currently an invalid bundle causes the harness to hang (no port announced).
