// Copyright 2025 the AAI authors. MIT license.
/**
 * Guest-side harness entrypoint.
 *
 * Connects to the host over a stream (vsock in production, Unix socket in
 * dev/test). Uses vscode-jsonrpc for request/response framing and dispatch.
 *
 * The guest is both:
 * - A server (responds to tool/execute, hook/invoke, bundle/load requests)
 * - A client (sends kv/* requests back to the host for KV operations)
 */

import type { Readable, Writable } from "node:stream";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { executeTool, initHarness, invokeHook, resetAgentEnv } from "./harness-logic.ts";

export type { KvInterface } from "./harness-logic.ts";

// ── createGuestConnection ─────────────────────────────────────────────────────

/**
 * Creates a vscode-jsonrpc connection for the guest harness.
 *
 * Also builds a KV proxy that sends JSON-RPC requests to the host for each
 * KV operation, awaiting the host's response before resolving.
 *
 * @param input  - Readable stream from the host (e.g. process.stdin, vsock)
 * @param output - Writable stream to the host
 */
export function createGuestConnection(input: Readable, output: Writable) {
  const conn = createMessageConnection(
    new StreamMessageReader(input),
    new StreamMessageWriter(output),
  );

  // KV proxy — guest calls host for KV operations
  const kv: KvInterface = {
    async get(key: string): Promise<unknown> {
      const resp = await conn.sendRequest<{ value?: unknown }>("kv/get", { key });
      return resp?.value ?? null;
    },
    async set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void> {
      await conn.sendRequest("kv/set", { key, value, expireIn: opts?.expireIn });
    },
    async del(key: string): Promise<void> {
      await conn.sendRequest("kv/del", { key });
    },
  };

  return { conn, kv };
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Full guest harness entrypoint.
 *
 * 1. Registers bundle/load handler and waits for the host to load the agent bundle
 * 2. Sets env vars from the bundle message (AAI_ENV_ prefix)
 * 3. Loads the agent code via new Function() (VM/vsock is the security boundary)
 * 4. Initializes harness logic (initHarness)
 * 5. Registers RPC handlers and enters concurrent dispatch loop
 */
export async function main(input: Readable, output: Writable): Promise<void> {
  const { conn, kv } = createGuestConnection(input, output);

  // Register bundle/load handler BEFORE listening so we don't miss it
  const bundle = await new Promise<{ code: string; env: Record<string, string> }>((resolve) => {
    conn.onRequest("bundle/load", (params: { code: string; env: Record<string, string> }) => {
      resolve(params);
      return { ok: true };
    });
    conn.listen();
  });

  // Set agent env vars with AAI_ENV_ prefix so harness-logic.ts can find them
  for (const [k, v] of Object.entries(bundle.env)) {
    process.env[`AAI_ENV_${k}`] = v;
  }
  resetAgentEnv(); // Clear cached env so getAgentEnv() picks up new vars

  // Load agent code — the VM/vsock channel is the security boundary.
  // Agent code is trusted within the VM; this evaluates the pre-compiled CJS bundle.
  // new Function() is intentional: VM is the security boundary.
  const mod = { exports: {} as Record<string, unknown> };
  const loadFn = new Function("module", "exports", bundle.code);
  loadFn(mod, mod.exports);

  // Extract default export (the agent definition)
  const agent = (mod.exports.default ?? mod.exports) as Parameters<typeof initHarness>[0];

  const { sessionState, hooks } = initHarness(agent, kv);

  // Register RPC methods for concurrent dispatch
  conn.onRequest("tool/execute", (params: Parameters<typeof executeTool>[1]) =>
    executeTool(agent, params, sessionState, kv),
  );

  conn.onRequest("hook/invoke", (params: Parameters<typeof invokeHook>[1]) =>
    invokeHook(hooks, params, sessionState),
  );

  conn.onNotification("shutdown", () => {
    conn.dispose();
    process.exit(0);
  });

  // Keep process alive — exits via process.exit(0) on shutdown notification
  await new Promise<never>(() => {
    // intentionally never resolves
  });
}

// Auto-start when run directly
const scriptName = process.argv[1] ?? "";
if (scriptName.endsWith("harness.mjs") || scriptName.endsWith("harness.ts")) {
  main(process.stdin, process.stdout).catch((err) => {
    console.error("Harness error:", err);
    process.exit(1);
  });
}
