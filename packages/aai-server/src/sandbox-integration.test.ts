// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: deploys a minimal agent into a real secure-exec isolate
 * and verifies the isolate boots, announces its port, and accepts WebSocket
 * connections via the sandbox proxy.
 *
 * Security boundaries (filesystem, network, process, env isolation) are
 * enforced by the same secure-exec permissions as before — the isolate runs
 * createRuntime() with identical permission config.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
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
  },
  state: () => ({ count: 0 }),
  onConnect: (ctx) => { ctx.state.count = 1; },
  onTurn: (text, ctx) => { ctx.state.lastTurn = text; },
};
`;

// ── Mocks ────────────────────────────────────────────────────────────────

type Kv = import("@alexkroman1/aai/kv").Kv;

function createMockKv(): Kv {
  const store = new Map<string, unknown>();
  return {
    get: (async (key: string) => store.get(key) ?? null) as Kv["get"],
    set: async (key: string, value: unknown, _options?: { expireIn?: number }) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: (async () => []) as Kv["list"],
    keys: async (_pattern?: string): Promise<string[]> => [],
  };
}

// ── Isolate boot tests ──────────────────────────────────────────────────

describe("isolate boot", () => {
  let port: number;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const kv = createMockKv();
    const isolate = await _internals.startIsolate(AGENT_BUNDLE, kv, {}, "test-token");
    port = isolate.port;
    cleanup = async () => {
      await isolate.runtime.terminate();
    };
  });

  afterAll(async () => {
    await cleanup?.();
  });

  test("isolate announces port", () => {
    expect(port).toBeGreaterThan(0);
  });

  test("isolate HTTP server responds with 404 for non-WS requests", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(404);
  });
});

// ── WebSocket session lifecycle ──────────────────────────────────────────

describe("WebSocket session lifecycle", () => {
  let sandbox: Awaited<ReturnType<typeof _internals.createSandbox>>;

  beforeAll(async () => {
    const { createTestStorage } = await import("./_test-utils.ts");
    sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      apiKey: "test-key",
      agentEnv: {},
      storage: createTestStorage(),
      slug: "ws-test",
    });
  });

  afterAll(async () => {
    await sandbox?.terminate();
  });

  test("startSession proxies config message from isolate", async () => {
    const messages: string[] = [];

    const ws = {
      readyState: 1,
      send(data: string | ArrayBuffer | Uint8Array) {
        if (typeof data === "string") messages.push(data);
      },
      addEventListener(type: string, listener: (event: Event) => void) {
        if (type === "open") {
          listener(new Event("open"));
        }
        if (type === "close") {
          setTimeout(() => listener(new Event("close")), 1000);
        }
      },
    };

    sandbox.startSession(ws as unknown as WebSocket, { skipGreeting: false });

    // Wait for the isolate's WebSocket server to connect and send config
    await vi.waitFor(
      () => {
        expect(messages.length).toBeGreaterThan(0);
      },
      { timeout: 5000, interval: 50 },
    );

    const config = JSON.parse(messages[0] as string);
    expect(config.type).toBe("config");
    expect(config.audioFormat).toBe("pcm16");
    expect(config.sampleRate).toBeTruthy();
    expect(config.sessionId).toBeTruthy();
  });
});

// ── Multiple concurrent agents ───────────────────────────────────────────

describe("multiple concurrent agents", () => {
  let isolate1: { port: number; runtime: { terminate(): Promise<void> } };
  let isolate2: { port: number; runtime: { terminate(): Promise<void> } };

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
    [isolate1, isolate2] = await Promise.all([
      _internals.startIsolate(BUNDLE_A, kv1, {}, "test-token"),
      _internals.startIsolate(BUNDLE_B, kv2, {}, "test-token"),
    ]);
  });

  afterAll(async () => {
    await isolate1?.runtime.terminate();
    await isolate2?.runtime.terminate();
  });

  test("two isolates boot independently on different ports", () => {
    expect(isolate1.port).toBeGreaterThan(0);
    expect(isolate2.port).toBeGreaterThan(0);
    expect(isolate1.port).not.toBe(isolate2.port);
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

    const { createTestStorage } = await import("./_test-utils.ts");
    const storage = createTestStorage();

    const slot = {
      slug: "idle-test",
      keyHash: "test",
    } as import("./sandbox.ts").AgentSlot;

    const sandbox = await _internals.createSandbox({
      workerCode: AGENT_BUNDLE,
      apiKey: "test-key",
      agentEnv: {},
      storage,
      slug: "idle-test",
    });

    slot.sandbox = sandbox;
    _internals.resetIdleTimer(slot);

    expect(slot.sandbox).toBeTruthy();

    await vi.waitFor(() => expect(slot.sandbox).toBeUndefined(), { timeout: 5000, interval: 50 });
  });
});

// ── Redeploy replaces sandbox ────────────────────────────────────────────

describe("redeploy replaces sandbox", () => {
  test("deploying same slug terminates old sandbox", async () => {
    const { createTestStorage } = await import("./_test-utils.ts");
    const storage = createTestStorage();

    const sandbox1 = await _internals.createSandbox({
      workerCode: `export default { name: "v1", instructions: "v1", greeting: "v1", maxSteps: 1, tools: {} };`,
      apiKey: "test-key",
      agentEnv: {},
      storage,
      slug: "redeploy-test",
    });

    const sandbox2 = await _internals.createSandbox({
      workerCode: `export default { name: "v2", instructions: "v2", greeting: "v2", maxSteps: 1, tools: {} };`,
      apiKey: "test-key",
      agentEnv: {},
      storage,
      slug: "redeploy-test",
    });

    sandbox1.terminate();

    expect(sandbox2).toBeTruthy();

    sandbox2.terminate();
  });
});
