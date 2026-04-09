# Deno Sandbox Guest Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Node.js guest runtime in gVisor sandboxes with Deno, switch to NDJSON transport, output ESM bundles, and remove the self-hosted `defineAgent`/`createServer` public API.

**Architecture:** The host (`aai-server`) stays Node.js. The guest harness is rewritten as a self-contained Deno script using `@std/streams` for NDJSON parsing and `data:` URL dynamic imports for loading agent code. The host-side transport switches from `vscode-jsonrpc` to a lightweight NDJSON module using `node:readline`. The bundler outputs ESM instead of CJS, and the CJS transform pipeline is deleted.

**Tech Stack:** Deno (guest), Node.js (host), esbuild (bundler), `@std/streams` (Deno NDJSON), `node:readline` (Node NDJSON), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-04-09-deno-sandbox-design.md`

**Worktree:** `.worktrees/deno-sandbox` on branch `feat/deno-sandbox`

---

## File Map

### New files
- `packages/aai-server/ndjson-transport.ts` — Host-side NDJSON connection (replaces vscode-jsonrpc)
- `packages/aai-server/ndjson-transport.test.ts` — Unit tests
- `packages/aai-server/guest/deno-harness.ts` — Deno guest harness (self-contained, no workspace imports)

### Modified files
- `packages/aai-server/sandbox-vm.ts` — Spawn Deno instead of Node, use NDJSON connection
- `packages/aai-server/sandbox-vm.test.ts` — Update mocks for Deno spawning
- `packages/aai-server/sandbox.ts` — Use NDJSON connection type, remove vscode-jsonrpc imports
- `packages/aai-server/gvisor.ts` — Mount Deno binary instead of Node
- `packages/aai-server/fake-vm-integration.test.ts` — Update for NDJSON + Deno harness
- `packages/aai-server/gvisor-integration.test.ts` — Update for Deno in gVisor
- `packages/aai-server/Dockerfile` — Install Deno alongside Node
- `packages/aai-server/guest/Dockerfile.gvisor` — Install Deno for integration tests
- `Dockerfile.test` — Install Deno for test suite
- `packages/aai-server/package.json` — Remove vscode-jsonrpc dependency
- `packages/aai-server/test-utils.ts` — Update mock bundle to ESM syntax
- `packages/aai-cli/_bundler.ts` — Remove CJS transform, remove extractAgentConfig, remove Vite SSR path
- `packages/aai-cli/_bundler.test.ts` — Remove deleted function tests
- `packages/aai-cli/_dev-server.ts` — Update imports from `@alexkroman1/aai/server` to `@alexkroman1/aai/host`
- `packages/aai-cli/_server-common.ts` — Update imports from `@alexkroman1/aai/server` to `@alexkroman1/aai/host`
- `packages/aai/package.json` — Remove `./server` public export
- `packages/aai/types.test-d.ts` — Remove `createServer` type tests
- `packages/aai-templates/scaffold/CLAUDE.md` — Remove self-hosting section
- `CLAUDE.md` — Update architecture, security model, key files

### Deleted files
- `packages/aai-server/guest/harness.ts` — Replaced by deno-harness.ts
- `packages/aai-server/guest/harness.test.ts` — Tests for old harness
- `packages/aai-server/guest/harness-logic.ts` — Logic absorbed into deno-harness.ts
- `packages/aai-server/harness-runtime.ts` — Legacy SecureExec dispatcher
- `packages/aai/host/server.ts` — Self-hosted HTTP server
- `packages/aai/host/server.test.ts` — Tests for createServer
- `packages/aai/host/server-shutdown.test.ts` — Tests for server shutdown

---

## Task 1: NDJSON Transport — Host Side

**Files:**
- Create: `packages/aai-server/ndjson-transport.ts`
- Create: `packages/aai-server/ndjson-transport.test.ts`

This module replaces `vscode-jsonrpc` for host↔guest communication. It provides the same interface shape (`sendRequest`, `onRequest`, `sendNotification`, `onNotification`, `listen`, `dispose`) over NDJSON (one JSON object per `\n`).

- [ ] **Step 1: Write failing tests for NDJSON message framing**

```ts
// packages/aai-server/ndjson-transport.test.ts
import { Readable, Writable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { createNdjsonConnection } from "./ndjson-transport.ts";

/** Helper: create a Readable from an array of NDJSON lines */
function readableFrom(lines: string[]): Readable {
  const data = lines.map((l) => `${l}\n`).join("");
  return Readable.from([data]);
}

/** Helper: create a Writable that captures output */
function writableCapture(): { writable: Writable; chunks: string[] } {
  const chunks: string[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { writable, chunks };
}

describe("createNdjsonConnection", () => {
  test("sends request and receives response", async () => {
    // Simulate guest responding to a request
    const responseMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const readable = readableFrom([responseMsg]);
    const { writable, chunks } = writableCapture();

    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const result = await conn.sendRequest("bundle/load", { code: "x", env: {} });
    expect(result).toEqual({ ok: true });

    // Verify the request was written as NDJSON
    const sent = JSON.parse(chunks[0].trim());
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.id).toBe(1);
    expect(sent.method).toBe("bundle/load");
    expect(sent.params).toEqual({ code: "x", env: {} });
  });

  test("dispatches incoming request to handler", async () => {
    const requestMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "kv/get",
      params: { key: "foo" },
    });
    const readable = readableFrom([requestMsg]);
    const { writable, chunks } = writableCapture();

    const conn = createNdjsonConnection(readable, writable);
    conn.onRequest("kv/get", async (params: { key: string }) => {
      return { value: `val-${params.key}` };
    });
    conn.listen();

    // Wait for the handler to process
    await vi.waitFor(() => {
      expect(chunks.length).toBeGreaterThan(0);
    });

    const response = JSON.parse(chunks[0].trim());
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(42);
    expect(response.result).toEqual({ value: "val-foo" });
  });

  test("dispatches incoming notification", async () => {
    const notifMsg = JSON.stringify({
      jsonrpc: "2.0",
      method: "shutdown",
    });
    const readable = readableFrom([notifMsg]);
    const { writable } = writableCapture();

    const handler = vi.fn();
    const conn = createNdjsonConnection(readable, writable);
    conn.onNotification("shutdown", handler);
    conn.listen();

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
  });

  test("sends notification (no id, no response expected)", async () => {
    const readable = readableFrom([]);
    const { writable, chunks } = writableCapture();

    const conn = createNdjsonConnection(readable, writable);
    conn.listen();
    conn.sendNotification("shutdown");

    await vi.waitFor(() => {
      expect(chunks.length).toBeGreaterThan(0);
    });

    const sent = JSON.parse(chunks[0].trim());
    expect(sent.jsonrpc).toBe("2.0");
    expect(sent.method).toBe("shutdown");
    expect(sent.id).toBeUndefined();
  });

  test("handles concurrent requests with correct id matching", async () => {
    // Two responses arriving out of order
    const resp2 = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { b: true } });
    const resp1 = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { a: true } });
    const readable = readableFrom([resp2, resp1]);
    const { writable } = writableCapture();

    const conn = createNdjsonConnection(readable, writable);
    conn.listen();

    const [r1, r2] = await Promise.all([
      conn.sendRequest("method-a", {}),
      conn.sendRequest("method-b", {}),
    ]);

    expect(r1).toEqual({ a: true });
    expect(r2).toEqual({ b: true });
  });

  test("dispose cleans up", () => {
    const readable = readableFrom([]);
    const { writable } = writableCapture();

    const conn = createNdjsonConnection(readable, writable);
    conn.listen();
    conn.dispose();
    // Should not throw
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run packages/aai-server/ndjson-transport.test.ts`
Expected: FAIL — module `./ndjson-transport.ts` does not exist

- [ ] **Step 3: Implement NDJSON transport**

```ts
// packages/aai-server/ndjson-transport.ts
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** JSON-RPC 2.0 message types */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !("method" in msg) && "id" in msg;
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export interface NdjsonConnection {
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  onRequest<T = unknown>(
    method: string,
    handler: (params: T) => unknown | Promise<unknown>,
  ): void;
  onNotification(method: string, handler: (params?: unknown) => void): void;
  listen(): void;
  dispose(): void;
}

export function createNdjsonConnection(
  readable: Readable,
  writable: Writable,
): NdjsonConnection {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  const requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >();
  const notificationHandlers = new Map<
    string,
    (params?: unknown) => void
  >();
  let disposed = false;

  function write(msg: JsonRpcMessage): void {
    if (disposed) return;
    writable.write(`${JSON.stringify(msg)}\n`);
  }

  async function handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (isResponse(msg)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
    } else if (isRequest(msg)) {
      const handler = requestHandlers.get(msg.method);
      if (handler) {
        try {
          const result = await handler(msg.params);
          write({ jsonrpc: "2.0", id: msg.id, result });
        } catch (err) {
          write({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    } else if (isNotification(msg)) {
      const handler = notificationHandlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  }

  return {
    sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      write({ jsonrpc: "2.0", id, method, params });
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });
    },

    sendNotification(method: string, params?: unknown): void {
      write({ jsonrpc: "2.0", method, params } as JsonRpcNotification);
    },

    onRequest(method, handler) {
      requestHandlers.set(method, handler as (params: unknown) => unknown);
    },

    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },

    listen() {
      const rl = createInterface({ input: readable, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMessage;
          handleMessage(msg);
        } catch {
          // Skip malformed lines
        }
      });
      rl.on("close", () => {
        disposed = true;
        for (const [, p] of pending) {
          p.reject(new Error("Connection closed"));
        }
        pending.clear();
      });
    },

    dispose() {
      disposed = true;
      for (const [, p] of pending) {
        p.reject(new Error("Connection disposed"));
      }
      pending.clear();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run packages/aai-server/ndjson-transport.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-server/ndjson-transport.ts packages/aai-server/ndjson-transport.test.ts
git commit -m "feat(aai-server): add NDJSON transport layer replacing vscode-jsonrpc"
```

---

## Task 2: Deno Guest Harness

**Files:**
- Create: `packages/aai-server/guest/deno-harness.ts`

This is a self-contained Deno script with **zero workspace imports**. It reads NDJSON from stdin, loads an ESM agent bundle via `data:` URL import, and dispatches tool/hook RPCs.

- [ ] **Step 1: Write the Deno guest harness**

```ts
// packages/aai-server/guest/deno-harness.ts
//
// Self-contained Deno guest harness for gVisor sandbox.
// NO workspace imports — this file must work standalone.
// Run: deno run --allow-env --no-prompt deno-harness.ts

import { TextLineStream } from "jsr:@std/streams@1/text-line-stream";

// ── Types (inlined — no workspace deps) ─────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface ToolDef {
  description: string;
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => unknown;
}

interface ToolContext {
  env: Readonly<Record<string, string>>;
  kv: KvInterface;
  messages: readonly Record<string, unknown>[];
  sessionId: string;
}

interface KvInterface {
  get: <T = unknown>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown, opts?: { expireIn?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

interface HookContext {
  env: Readonly<Record<string, string>>;
  kv: KvInterface;
  sessionId: string;
}

type HookFn = ((...args: unknown[]) => unknown) | undefined;

interface Agent {
  tools?: Record<string, ToolDef>;
  onConnect?: HookFn;
  onDisconnect?: HookFn;
  onUserTranscript?: HookFn;
  onError?: HookFn;
  state?: () => Record<string, unknown>;
  [key: string]: unknown;
}

// ── NDJSON I/O ──────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function writeMessage(msg: JsonRpcResponse | JsonRpcNotification | JsonRpcRequest): void {
  const line = JSON.stringify(msg) + "\n";
  Deno.stdout.writeSync(encoder.encode(line));
}

function sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
  const id = nextOutgoingId++;
  writeMessage({ jsonrpc: "2.0", id, method, params } as JsonRpcRequest);
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject });
  });
}

let nextOutgoingId = 1;
const pendingRequests = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

// ── Session State ───────────────────────────────────────────────────────────

const sessionStates = new Map<string, Record<string, unknown>>();
let stateFactory: (() => Record<string, unknown>) | null = null;

function getSessionState(sessionId: string): Record<string, unknown> {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = stateFactory ? structuredClone(stateFactory()) : {};
    sessionStates.set(sessionId, state);
  }
  return state;
}

// ── Environment ─────────────────────────────────────────────────────────────

let agentEnvCache: Readonly<Record<string, string>> | null = null;

function getAgentEnv(): Readonly<Record<string, string>> {
  if (agentEnvCache) return agentEnvCache;
  const env: Record<string, string> = {};
  const prefix = "AAI_ENV_";
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (k.startsWith(prefix)) {
      env[k.slice(prefix.length)] = v;
    }
  }
  agentEnvCache = Object.freeze(env);
  return agentEnvCache;
}

// ── KV Proxy ────────────────────────────────────────────────────────────────

function createKv(): KvInterface {
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const resp = await sendRequest<{ value?: T }>("kv/get", { key });
      return resp.value ?? null;
    },
    async set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void> {
      await sendRequest("kv/set", { key, value, ...opts });
    },
    async delete(key: string): Promise<void> {
      await sendRequest("kv/del", { key });
    },
  };
}

// ── Tool Execution ──────────────────────────────────────────────────────────

const TOOL_TIMEOUT_MS = 30_000;

async function executeTool(
  agent: Agent,
  params: Record<string, unknown>,
  kv: KvInterface,
): Promise<Record<string, unknown>> {
  const { name, args, sessionId, messages } = params as {
    name: string;
    args: Record<string, unknown>;
    sessionId: string;
    messages: Record<string, unknown>[];
  };

  const tool = agent.tools?.[name];
  if (!tool) return { error: `Unknown tool: ${name}` };

  const state = getSessionState(sessionId);
  const ctx: ToolContext = {
    env: getAgentEnv(),
    kv,
    messages,
    sessionId,
  };

  try {
    const resultPromise = Promise.resolve(tool.execute(args, ctx));
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS),
    );
    const result = await Promise.race([resultPromise, timeoutPromise]);
    return { result: typeof result === "string" ? result : JSON.stringify(result), state };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Hook Invocation ─────────────────────────────────────────────────────────

const HOOK_TIMEOUT_MS = 5_000;

async function invokeHook(
  agent: Agent,
  params: Record<string, unknown>,
  kv: KvInterface,
): Promise<Record<string, unknown>> {
  const { hook, sessionId, ...rest } = params as {
    hook: string;
    sessionId?: string;
    [key: string]: unknown;
  };

  const sid = sessionId ?? "default";
  const hookFn = agent[hook] as HookFn;
  if (!hookFn) return { state: getSessionState(sid) };

  const ctx: HookContext = { env: getAgentEnv(), kv, sessionId: sid };

  try {
    let resultPromise: Promise<unknown>;
    if (hook === "onUserTranscript") {
      resultPromise = Promise.resolve(hookFn(rest.text, ctx));
    } else if (hook === "onError") {
      resultPromise = Promise.resolve(hookFn(rest.error, ctx));
    } else {
      resultPromise = Promise.resolve(hookFn(ctx));
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Hook "${hook}" timed out after ${HOOK_TIMEOUT_MS}ms`)), HOOK_TIMEOUT_MS),
    );
    const result = await Promise.race([resultPromise, timeoutPromise]);
    return { state: getSessionState(sid), result };
  } catch (err) {
    return { state: getSessionState(sid), error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const lineStream = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  let agent: Agent | null = null;
  const kv = createKv();

  for await (const line of lineStream) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Handle responses to our outgoing requests (kv/*)
    if (!("method" in msg) && "id" in msg) {
      const resp = msg as unknown as JsonRpcResponse;
      const p = pendingRequests.get(resp.id);
      if (p) {
        pendingRequests.delete(resp.id);
        if (resp.error) {
          p.reject(new Error(resp.error.message));
        } else {
          p.resolve(resp.result);
        }
      }
      continue;
    }

    // Handle notifications (shutdown)
    if ("method" in msg && !("id" in msg)) {
      if (msg.method === "shutdown") {
        Deno.exit(0);
      }
      continue;
    }

    // Handle requests from host
    const req = msg as unknown as JsonRpcRequest;

    if (req.method === "bundle/load") {
      const { code, env } = req.params as { code: string; env: Record<string, string> };

      // Inject env vars
      for (const [k, v] of Object.entries(env)) {
        Deno.env.set(`AAI_ENV_${k}`, v);
      }
      agentEnvCache = null; // Reset cache after injection

      // Load ESM bundle via data: URL import
      const mod = await import(`data:application/javascript,${encodeURIComponent(code)}`);
      agent = (mod.default ?? mod) as Agent;

      if (agent.state && typeof agent.state === "function") {
        stateFactory = agent.state;
      }

      writeMessage({ jsonrpc: "2.0", id: req.id, result: { ok: true } });
      continue;
    }

    if (!agent) {
      writeMessage({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Agent not loaded" },
      });
      continue;
    }

    if (req.method === "tool/execute") {
      const result = await executeTool(agent, req.params ?? {}, kv);
      writeMessage({ jsonrpc: "2.0", id: req.id, result });
      continue;
    }

    if (req.method === "hook/invoke") {
      const result = await invokeHook(agent, req.params ?? {}, kv);
      writeMessage({ jsonrpc: "2.0", id: req.id, result });
      continue;
    }

    // Unknown method
    writeMessage({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `Unknown method: ${req.method}` },
    });
  }
}

main();
```

- [ ] **Step 2: Verify the harness parses correctly with Deno**

Run: `deno check packages/aai-server/guest/deno-harness.ts`
Expected: No type errors (Deno must be installed locally)

Note: If Deno is not installed, install it first: `curl -fsSL https://deno.land/install.sh | sh`

- [ ] **Step 3: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-server/guest/deno-harness.ts
git commit -m "feat(aai-server): add Deno guest harness with NDJSON transport"
```

---

## Task 3: ESM Bundling — Remove CJS Transform Pipeline

**Files:**
- Modify: `packages/aai-cli/_bundler.ts`
- Modify: `packages/aai-cli/_bundler.test.ts`

Remove `transformBundleForEval()`, `extractAgentConfig()`, the Vite SSR single-file build path, and `node:vm` usage. Keep esbuild for directory-based agents (already ESM).

- [ ] **Step 1: Read the current bundler to identify exact removal boundaries**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && cat -n packages/aai-cli/_bundler.ts`

Identify line ranges for: `transformBundleForEval`, `extractAgentConfig`, `bundleAgent` (Vite SSR path), `node:vm` import, `zod` import (if only used by extractAgentConfig), `agentToolsToSchemas` import.

- [ ] **Step 2: Remove `transformBundleForEval` function and its tests**

Delete `transformBundleForEval()` from `_bundler.ts`. Delete the entire `describe("transformBundleForEval", ...)` block from `_bundler.test.ts`.

- [ ] **Step 3: Remove `extractAgentConfig` function and its tests**

Delete `extractAgentConfig()` from `_bundler.ts`. Delete the entire `describe("extractAgentConfig", ...)` block from `_bundler.test.ts`. Remove the `runInNewContext` import from `node:vm`, the `zod` import, and the `agentToolsToSchemas` import if no longer used.

- [ ] **Step 4: Remove the Vite SSR single-file build path**

Delete the `bundleAgent()` function (the Vite SSR build path for `agent.ts` files) from `_bundler.ts`. Remove the `vite` import if no longer used. Delete any tests for `bundleAgent` in `_bundler.test.ts`.

- [ ] **Step 5: Update bundle output to ESM format**

Verify that `compileFile()` (directory-based agent tool/hook compilation) already uses `format: "esm"`. If the deploy path still references `worker.js`, update it to expect ESM output.

- [ ] **Step 6: Run bundler tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run --project aai-cli -- _bundler`
Expected: PASS (remaining tests for `BundleError`, `compileFile`, etc.)

- [ ] **Step 7: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-cli/_bundler.ts packages/aai-cli/_bundler.test.ts
git commit -m "refactor(aai-cli): remove CJS transform pipeline, keep ESM-only bundling"
```

---

## Task 4: Update Sandbox VM to Spawn Deno

**Files:**
- Modify: `packages/aai-server/sandbox-vm.ts`
- Modify: `packages/aai-server/sandbox-vm.test.ts`
- Modify: `packages/aai-server/sandbox.ts`

Replace `fork()`/`spawn(node, ...)` with `spawn("deno", ["run", "--allow-env", "--no-prompt", ...])`. Replace vscode-jsonrpc `StreamMessageReader`/`StreamMessageWriter` with `createNdjsonConnection`.

- [ ] **Step 1: Read current sandbox-vm.ts to understand exact changes**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && cat -n packages/aai-server/sandbox-vm.ts`

- [ ] **Step 2: Update imports — replace vscode-jsonrpc with NDJSON transport**

In `sandbox-vm.ts`:
- Remove: `import { createMessageConnection, type MessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";`
- Add: `import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";`
- Update the `SandboxHandle` type to use `NdjsonConnection` instead of `MessageConnection`.

- [ ] **Step 3: Update `createConnection` helper**

Replace the `createConnection` function:

```ts
// Old: vscode-jsonrpc
function createConnection(child: ChildProcess): MessageConnection {
  if (!(child.stdout && child.stdin)) throw new Error("Child process missing stdio");
  return createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
}

// New: NDJSON
function createConnection(child: ChildProcess): NdjsonConnection {
  if (!(child.stdout && child.stdin)) throw new Error("Child process missing stdio");
  return createNdjsonConnection(child.stdout, child.stdin);
}
```

- [ ] **Step 4: Update `createDevSandbox` — spawn Deno instead of fork**

Replace `fork(opts.harnessPath, ...)` with:

```ts
const child = spawn("deno", ["run", "--allow-env", "--no-prompt", opts.harnessPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});
```

Change the import from `fork` to `spawn` (from `node:child_process`).

- [ ] **Step 5: Update `createGvisorSandbox` in gvisor.ts — mount Deno binary**

In `gvisor.ts`, change the command from `process.execPath` (node) to `"deno"` with appropriate args:

```ts
// Old:
const child = spawn(runsc, [
  "--rootless", "--network=none", "--ignore-cgroups",
  "do", "-quiet", "-cwd", "/tmp", "--",
  process.execPath, opts.harnessPath,
], { ... });

// New:
const child = spawn(runsc, [
  "--rootless", "--network=none", "--ignore-cgroups",
  "do", "-quiet", "-cwd", "/tmp", "--",
  "deno", "run", "--allow-env", "--no-prompt", opts.harnessPath,
], { ... });
```

- [ ] **Step 6: Update sandbox.ts — use NdjsonConnection type**

Replace `MessageConnection` type references with `NdjsonConnection`. Remove `vscode-jsonrpc` import if present. The RPC call patterns (`conn.sendRequest`, `conn.onRequest`, etc.) stay the same since `NdjsonConnection` has the same interface.

- [ ] **Step 7: Update sandbox-vm.test.ts**

Update mocks to expect `spawn("deno", ...)` instead of `fork(...)`. Update any `StreamMessageReader`/`StreamMessageWriter` assertions to expect NDJSON format.

- [ ] **Step 8: Run sandbox-vm tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run --project aai-server -- sandbox-vm`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-server/sandbox-vm.ts packages/aai-server/sandbox-vm.test.ts packages/aai-server/sandbox.ts packages/aai-server/gvisor.ts
git commit -m "refactor(aai-server): spawn Deno guest with NDJSON transport"
```

---

## Task 5: Delete Old Node Guest Harness

**Files:**
- Delete: `packages/aai-server/guest/harness.ts`
- Delete: `packages/aai-server/guest/harness.test.ts`
- Delete: `packages/aai-server/guest/harness-logic.ts`
- Delete: `packages/aai-server/harness-runtime.ts`

- [ ] **Step 1: Verify no remaining imports of deleted files**

Run:
```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
grep -r "harness-logic" packages/aai-server/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts" | grep -v "guest/harness.ts"
grep -r "harness-runtime" packages/aai-server/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts"
grep -r "guest/harness" packages/aai-server/ --include="*.ts" | grep -v node_modules | grep -v "deno-harness" | grep -v ".test.ts"
```

Update any remaining references (e.g., in `sandbox-vm.ts` the `GUEST_HARNESS_PATH` env var or config) to point to `guest/deno-harness.ts`.

- [ ] **Step 2: Delete the files**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
rm packages/aai-server/guest/harness.ts
rm packages/aai-server/guest/harness.test.ts
rm packages/aai-server/guest/harness-logic.ts
rm packages/aai-server/harness-runtime.ts
```

- [ ] **Step 3: Run aai-server unit tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run --project aai-server`
Expected: PASS (no remaining references to deleted files). Fix any import errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add -A packages/aai-server/guest/ packages/aai-server/harness-runtime.ts
git commit -m "refactor(aai-server): remove Node.js guest harness and harness-runtime"
```

---

## Task 6: Remove Self-Hosted Public API

**Files:**
- Delete: `packages/aai/host/server.ts`
- Delete: `packages/aai/host/server.test.ts`
- Delete: `packages/aai/host/server-shutdown.test.ts`
- Modify: `packages/aai/package.json` — remove `./server` export
- Modify: `packages/aai/host/index.ts` — remove `server.ts` re-export
- Modify: `packages/aai/types.test-d.ts` — remove `createServer` type tests
- Modify: `packages/aai-cli/_dev-server.ts` — change import from `@alexkroman1/aai/server` to `@alexkroman1/aai/host`
- Modify: `packages/aai-cli/_server-common.ts` — change import from `@alexkroman1/aai/server` to `@alexkroman1/aai/host`

- [ ] **Step 1: Remove `./server` from package.json exports**

In `packages/aai/package.json`, delete the entire `"./server"` export entry.

- [ ] **Step 2: Update host/index.ts barrel**

Remove the re-export of `server.ts` if it exists.

- [ ] **Step 3: Delete server files**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
rm packages/aai/host/server.ts
rm packages/aai/host/server.test.ts
rm packages/aai/host/server-shutdown.test.ts
```

- [ ] **Step 4: Update aai-cli imports**

In `packages/aai-cli/_dev-server.ts` and `packages/aai-cli/_server-common.ts`:
- Change `from "@alexkroman1/aai/server"` to `from "@alexkroman1/aai/host"`
- Verify the imported symbols (`createRuntime`, `createServer` if still used internally, `AgentServer` type) are available from the host barrel

Note: `createServer` functionality may still be needed internally for `aai dev`. If so, keep the function in `host/server.ts` but do NOT export it via `./server` in package.json. The `./host` internal export still makes it available to workspace packages.

- [ ] **Step 5: Update type-level tests**

In `packages/aai/types.test-d.ts`, remove the `describe("createServer", ...)` test block that asserts on `createServer` and `AgentServer` types.

- [ ] **Step 6: Run tests**

Run:
```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
pnpm vitest run --project aai
pnpm vitest run --project aai-cli
pnpm vitest run --project aai-types
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai/package.json packages/aai/host/ packages/aai/types.test-d.ts packages/aai-cli/_dev-server.ts packages/aai-cli/_server-common.ts
git commit -m "feat(aai)!: remove self-hosted ./server public API

BREAKING CHANGE: The ./server export (createServer, createAgentApp) is removed.
Use directory-based agents deployed to the platform instead."
```

---

## Task 7: Remove vscode-jsonrpc Dependency

**Files:**
- Modify: `packages/aai-server/package.json`

- [ ] **Step 1: Remove vscode-jsonrpc from dependencies**

In `packages/aai-server/package.json`, remove `"vscode-jsonrpc"` from `dependencies`.

- [ ] **Step 2: Verify no remaining imports**

Run:
```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
grep -r "vscode-jsonrpc" packages/ --include="*.ts" | grep -v node_modules
```
Expected: No results (all usages already replaced in Tasks 4-5)

- [ ] **Step 3: Run pnpm install**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm install`

- [ ] **Step 4: Run all aai-server tests**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run --project aai-server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-server/package.json pnpm-lock.yaml
git commit -m "chore(aai-server): remove vscode-jsonrpc dependency"
```

---

## Task 8: Update Docker Images

**Files:**
- Modify: `packages/aai-server/Dockerfile`
- Modify: `packages/aai-server/guest/Dockerfile.gvisor`
- Modify: `Dockerfile.test`

All three need Deno installed alongside Node.

- [ ] **Step 1: Add Deno install to production Dockerfile**

In `packages/aai-server/Dockerfile`, add Deno install in the production stage (after gVisor install):

```dockerfile
# Install Deno — guest harness runtime
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
```

Update the harness path env var:
```dockerfile
ENV GUEST_HARNESS_PATH=/app/packages/aai-server/dist/guest/deno-harness.ts
```

- [ ] **Step 2: Add Deno install to gVisor test Dockerfile**

In `packages/aai-server/guest/Dockerfile.gvisor`, add after gVisor install:

```dockerfile
# Install Deno — guest harness runtime
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
    && deno --version
```

- [ ] **Step 3: Add Deno install to test Dockerfile**

In `Dockerfile.test`, add after git install:

```dockerfile
# Install Deno — needed for sandbox tests
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
```

- [ ] **Step 4: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-server/Dockerfile packages/aai-server/guest/Dockerfile.gvisor Dockerfile.test
git commit -m "chore(docker): install Deno in server and test images"
```

---

## Task 9: Update Integration Tests

**Files:**
- Modify: `packages/aai-server/fake-vm-integration.test.ts`
- Modify: `packages/aai-server/gvisor-integration.test.ts`
- Modify: `packages/aai-server/test-utils.ts`

- [ ] **Step 1: Read current integration tests**

Run:
```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
cat -n packages/aai-server/fake-vm-integration.test.ts
cat -n packages/aai-server/gvisor-integration.test.ts
cat -n packages/aai-server/test-utils.ts
```

Understand what they assert and what needs to change.

- [ ] **Step 2: Update test-utils.ts mock bundles to ESM**

Change any mock worker code from CJS format to ESM:

```ts
// Old:
'module.exports = { name: "test-agent", ... };'

// New:
'export default { name: "test-agent", tools: {}, systemPrompt: "test" };'
```

- [ ] **Step 3: Update fake-vm-integration.test.ts**

- Replace vscode-jsonrpc imports with `createNdjsonConnection`
- Update the process spawn from `fork()` / `node` to `spawn("deno", ["run", "--allow-env", "--no-prompt", harnessPath])`
- Update the connection setup to use `createNdjsonConnection(child.stdout, child.stdin)`
- Update the harness path to point to `guest/deno-harness.ts`
- Keep the same RPC assertions (bundle/load, tool/execute, hook/invoke, kv/*, shutdown)

- [ ] **Step 4: Update gvisor-integration.test.ts**

- Replace vscode-jsonrpc imports with `createNdjsonConnection`
- Update the gVisor spawn command to use Deno binary
- Add test for Deno permission denials (verify agent code cannot access net/fs)
- Update connection setup to use NDJSON

- [ ] **Step 5: Run integration tests locally (fake-vm only, no gVisor on macOS)**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm vitest run packages/aai-server/fake-vm-integration.test.ts`
Expected: PASS (requires Deno installed locally)

- [ ] **Step 6: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add packages/aai-server/fake-vm-integration.test.ts packages/aai-server/gvisor-integration.test.ts packages/aai-server/test-utils.ts
git commit -m "test(aai-server): update integration tests for Deno guest + NDJSON"
```

---

## Task 10: Update Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `packages/aai-templates/scaffold/CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

Key changes:
- Overview: Remove "Self-hosted: `defineAgent()` → ..." line
- Architecture table: Update `packages/aai/` description — remove `createServer`
- Package exports: Remove `./server` entry, remove `defineAgent`/`defineTool` mentions
- SDK structure: Note `host/server.ts` is deleted. Add `guest/deno-harness.ts` to key files.
- Key files: Remove `harness-runtime.ts`, update `guest/harness.ts` → `guest/deno-harness.ts`
- Data flow: No change (transparent to data flow)
- Conventions: Add "Deno required for dev (guest sandbox runtime)"
- Security: Update gVisor section — "guest runs Deno binary" + "Deno permission model provides defense-in-depth"
- Security: Update transport — "NDJSON over stdio" instead of "vscode-jsonrpc over stdio"
- Remove `harness-runtime.ts` rules section

- [ ] **Step 2: Update scaffold CLAUDE.md**

Remove the entire "Self-hosting with `createServer()`" section. Remove the "Headless voice session" section if it references self-hosted imports. Keep all directory-based agent documentation.

- [ ] **Step 3: Commit**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add CLAUDE.md packages/aai-templates/scaffold/CLAUDE.md
git commit -m "docs: update for Deno sandbox and removal of self-hosted API"
```

---

## Task 11: Full Validation & Changeset

- [ ] **Step 1: Run full local check**

Run: `cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox && pnpm check:local`
Expected: PASS (build, typecheck, lint, publint, syncpack, tests)

- [ ] **Step 2: Fix any failures**

Address typecheck errors, lint warnings, publint export validation failures, test failures. This is the catch-all step.

- [ ] **Step 3: Create changeset**

Run:
```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
unset GIT_DIR
pnpm changeset:create --pkg @alexkroman1/aai --bump major --summary "Remove self-hosted ./server API (defineAgent, createServer). Platform sandbox now uses Deno guest runtime with NDJSON transport."
```

- [ ] **Step 4: Commit changeset**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git add .changeset/
git commit -m "chore: add changeset for Deno sandbox migration (major)"
```

- [ ] **Step 5: Push and create PR**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/deno-sandbox
git fetch origin main && git rebase origin/main
git push -u origin feat/deno-sandbox
```

Then create PR with summary referencing the design spec.
