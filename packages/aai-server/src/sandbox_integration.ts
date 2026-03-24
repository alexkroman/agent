// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration test: deploys a minimal agent into a real secure-exec isolate
 * and verifies the host ↔ isolate protocol end-to-end.
 *
 * Run: pnpm --filter @alexkroman1/aai-server test:integration
 * (Requires build first: pnpm --filter @alexkroman1/aai-server build)
 *
 * Runs as a standalone script (not vitest) because isolated-vm's native
 * module doesn't survive vitest worker forking. Must always pass in CI.
 */

import type {
  HookRequest,
  HookResponse,
  IsolateConfig,
  ToolCallRequest,
  ToolCallResponse,
} from "./_harness_protocol.ts";
import { _internals } from "./sandbox.ts";

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
  },
  state: () => ({ count: 0 }),
  onConnect: (ctx) => { ctx.state.count = 1; },
  onTurn: (text, ctx) => { ctx.state.lastTurn = text; },
};
`;

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

let passed = 0;
let failed = 0;

async function assert(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function eq(actual: unknown, expected: unknown, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? `${label}: ` : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

async function main() {
  console.log("sandbox integration test");
  console.log("starting isolate...");

  const kv = createMockKv();
  const cap = await _internals.startCapabilityServer(kv, undefined);
  const isolate = await _internals.startIsolate(AGENT_BUNDLE, cap.url);
  const port = isolate.port;

  console.log(`isolate ready on port ${port}\n`);

  try {
    await assert("GET /config returns valid IsolateConfig", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/config`);
      eq(res.ok, true, "response ok");
      const config = (await res.json()) as IsolateConfig;
      eq(config.name, "integration-test", "name");
      eq(config.instructions, "You are a test agent.", "instructions");
      eq(config.greeting, "Hello from the isolate", "greeting");
      eq(config.maxSteps, 3, "maxSteps");
      eq(config.hasState, true, "hasState");
      eq(config.hooks.onConnect, true, "hooks.onConnect");
      eq(config.hooks.onTurn, true, "hooks.onTurn");
      eq(config.hooks.onDisconnect, false, "hooks.onDisconnect");
      eq(config.hooks.maxStepsIsFn, false, "hooks.maxStepsIsFn");
      eq(config.toolSchemas.length, 1, "toolSchemas.length");
      eq(config.toolSchemas[0]?.name, "echo", "toolSchemas[0].name");
      eq(config.toolSchemas[0]?.description, "Echo the input", "toolSchemas[0].description");
    });

    await assert("POST /tool executes tool and returns result", async () => {
      const req: ToolCallRequest = {
        name: "echo",
        args: { text: "hello world" },
        sessionId: "s1",
        messages: [],
        env: {},
      };
      const res = await fetch(`http://127.0.0.1:${port}/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      eq(res.ok, true, "response ok");
      const result = (await res.json()) as ToolCallResponse;
      eq(result.result, "echo:hello world", "result");
    });

    await assert("POST /tool returns 404 for unknown tool", async () => {
      const req: ToolCallRequest = {
        name: "nonexistent",
        args: {},
        sessionId: "s1",
        messages: [],
        env: {},
      };
      const res = await fetch(`http://127.0.0.1:${port}/tool`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      eq(res.status, 404, "status");
    });

    await assert("POST /hook invokes onConnect and updates state", async () => {
      const req: HookRequest = {
        hook: "onConnect",
        sessionId: "hook-s1",
        env: {},
      };
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      eq(res.ok, true, "response ok");
      const result = (await res.json()) as HookResponse;
      eq(result.state.count, 1, "state.count");
    });

    await assert("POST /hook invokes onTurn with text", async () => {
      const req: HookRequest = {
        hook: "onTurn",
        sessionId: "hook-s1",
        env: {},
        text: "user said something",
      };
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      eq(res.ok, true, "response ok");
      const result = (await res.json()) as HookResponse;
      eq(result.state.lastTurn, "user said something", "state.lastTurn");
    });

    await assert("POST /hook resolveTurnConfig returns null for static maxSteps", async () => {
      const req: HookRequest = {
        hook: "resolveTurnConfig",
        sessionId: "hook-s1",
        env: {},
      };
      const res = await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      eq(res.ok, true, "response ok");
      const result = (await res.json()) as HookResponse;
      eq(result.result, null, "result");
    });
  } finally {
    isolate.runtime.dispose();
    cap.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
