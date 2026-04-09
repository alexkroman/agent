// Copyright 2025 the AAI authors. MIT license.
/**
 * Guest-side harness entrypoint for Firecracker microVMs.
 *
 * Connects to the host over vsock, receives the agent bundle, and runs a
 * concurrent RPC dispatch loop. The guest is both:
 * - A server (for tool calls and hook invocations from the host)
 * - A client (for KV operations proxied back to the host)
 *
 * This is the mirror of vsock.ts (host-side RPC channel) but tailored for
 * the guest environment with tool/hook dispatch and KV proxy.
 */

import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import type { HookRequest, ToolCallRequest } from "../rpc-schemas.ts";
import { executeTool, initHarness, invokeHook, resetAgentEnv } from "./harness-logic.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type GuestHandlers = {
  onTool(req: ToolCallRequest & { id: string }): Promise<unknown>;
  onHook(req: HookRequest & { id: string }): Promise<unknown>;
};

type KvProxy = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void>;
  del(key: string): Promise<void>;
  mget(keys: string[]): Promise<unknown[]>;
};

type GuestRpc = {
  kv: KvProxy;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const KV_TIMEOUT_MS = 5000;

// ── createGuestRpc ────────────────────────────────────────────────────────────

/**
 * Sets up bidirectional JSON-over-stream RPC for the guest harness.
 *
 * - Reads newline-delimited JSON from `stream`
 * - Incoming messages matching a pending guest request id → resolve that pending request
 * - Incoming messages without a matching pending id → dispatch to handlers concurrently
 * - Guest-initiated ids use the `g:` prefix
 * - Returns a KV proxy that sends KV requests to the host and awaits responses
 */
export function createGuestRpc(stream: Duplex, handlers: GuestHandlers): GuestRpc {
  let idCounter = 0;
  const pending = new Map<string, PendingRequest>();

  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  function sendLine(msg: Record<string, unknown>): void {
    stream.write(`${JSON.stringify(msg)}\n`);
  }

  function handleResponse(id: string, msg: Record<string, unknown>): boolean {
    const entry = pending.get(id);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(msg);
    return true;
  }

  function handleIncomingRequest(id: string, msg: Record<string, unknown>): void {
    const type = typeof msg.type === "string" ? msg.type : undefined;
    if (type === undefined) return;

    if (type === "shutdown") {
      // Respond ok, then exit
      sendLine({ id, ok: true });
      // Allow the write to flush before exiting
      setImmediate(() => process.exit(0));
      return;
    }

    let handlerPromise: Promise<unknown>;
    if (type === "tool") {
      handlerPromise = handlers.onTool(msg as unknown as ToolCallRequest & { id: string });
    } else if (type === "hook") {
      handlerPromise = handlers.onHook(msg as unknown as HookRequest & { id: string });
    } else {
      // Unknown type — send an error response
      sendLine({ id, error: `Unknown RPC type: ${type}` });
      return;
    }

    // Concurrent dispatch: fire-and-forget, keep read loop non-blocking
    void handlerPromise
      .then((result) => {
        sendLine({ id, ...(result as Record<string, unknown>) });
      })
      .catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : "Internal error";
        sendLine({ id, error: errMsg });
      });
  }

  function handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      // Silently ignore malformed JSON
      return;
    }

    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (id === undefined) return;

    // If id matches a pending guest-initiated request, resolve it (KV response)
    if (!handleResponse(id, msg)) {
      // Otherwise it's a host-initiated request — dispatch to handlers
      handleIncomingRequest(id, msg);
    }
  }

  rl.on("line", handleLine);

  stream.on("close", () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Connection closed"));
    }
    pending.clear();
    rl.close();
  });

  stream.on("error", () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Connection closed"));
    }
    pending.clear();
    rl.close();
  });

  // ── Guest-initiated request helper ─────────────────────────────────────────

  function guestRequest(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `g:${++idCounter}`;

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`KV timeout after ${KV_TIMEOUT_MS}ms`));
      }, KV_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });
      sendLine({ ...msg, id });
    });
  }

  // ── KV proxy ──────────────────────────────────────────────────────────────

  const kv: KvProxy = {
    async get(key: string): Promise<unknown> {
      const resp = await guestRequest({ type: "kv", op: "get", key });
      return resp.value ?? null;
    },

    async set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void> {
      const msg: Record<string, unknown> = { type: "kv", op: "set", key, value };
      if (opts?.expireIn !== undefined) {
        msg.expireIn = opts.expireIn;
      }
      await guestRequest(msg);
    },

    async del(key: string): Promise<void> {
      await guestRequest({ type: "kv", op: "del", key });
    },

    async mget(keys: string[]): Promise<unknown[]> {
      const resp = await guestRequest({ type: "kv", op: "mget", keys });
      return (resp.values as unknown[]) ?? [];
    },
  };

  return { kv };
}

// ── main ──────────────────────────────────────────────────────────────────────

/**
 * Full guest harness entrypoint.
 *
 * 1. Waits for the host to send a `bundle` message
 * 2. Responds with `{id, ok: true}`
 * 3. Sets env vars from the bundle message
 * 4. Loads the agent code via `new Function()` (VM is the security boundary)
 * 5. Initializes harness logic (initHarness)
 * 6. Enters concurrent RPC dispatch loop
 */
export async function main(stream: Duplex): Promise<void> {
  // Read the bundle message first (before setting up the full RPC loop)
  let bundleResolve: ((msg: Record<string, unknown>) => void) | undefined;
  const bundlePromise = new Promise<Record<string, unknown>>((resolve) => {
    bundleResolve = resolve;
  });

  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let bundleReceived = false;

  rl.on("line", (line: string) => {
    if (bundleReceived) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "bundle" && typeof msg.id === "string") {
      bundleReceived = true;
      rl.close();
      bundleResolve?.(msg);
    }
  });

  const bundleMsg = await bundlePromise;

  // Respond ok
  stream.write(`${JSON.stringify({ id: bundleMsg.id, ok: true })}\n`);

  // Set env vars from the bundle with AAI_ENV_ prefix so harness-logic.ts
  // can find them (it filters process.env by that prefix).
  const env = (bundleMsg.env ?? {}) as Record<string, string>;
  for (const [k, v] of Object.entries(env)) {
    process.env[`AAI_ENV_${k}`] = v;
  }
  resetAgentEnv(); // Clear cached env so getAgentEnv() picks up new vars

  // Load agent code — the Firecracker VM is the security boundary.
  // Agent code is trusted within the VM; new Function() is the appropriate
  // mechanism for loading a pre-compiled ESM bundle as a CommonJS wrapper.
  const code = bundleMsg.code as string;
  const mod = { exports: {} as Record<string, unknown> };
  // new Function() is intentional here: the Firecracker VM is the security
  // boundary, and the agent bundle is a pre-compiled CJS wrapper that must be
  // evaluated in the guest environment. No biome suppression needed because
  // new Function() is distinct from eval() and not covered by noGlobalEval.
  const loadFn = Function("module", "exports", code); // eslint-disable-line no-new-func
  loadFn(mod, mod.exports);

  // Extract default export (the agent definition)
  const agent = (mod.exports.default ?? mod.exports) as Parameters<typeof initHarness>[0];

  // Use late binding so handlers read harnessState at call time (not definition time).
  // createGuestRpc doesn't invoke handlers until messages arrive, and no messages
  // arrive until after main() finishes setup — so harnessState is always set by then.
  let harnessState: ReturnType<typeof initHarness>;

  const rpc = createGuestRpc(stream, {
    async onTool(req): Promise<unknown> {
      return executeTool(
        agent,
        req as unknown as Parameters<typeof executeTool>[1],
        harnessState.sessionState,
        rpc.kv,
      );
    },
    async onHook(req): Promise<unknown> {
      return invokeHook(
        harnessState.hooks,
        req as unknown as Parameters<typeof invokeHook>[1],
        harnessState.sessionState,
      );
    },
  });

  // Now init harness with the real KV proxy (not a stub)
  harnessState = initHarness(agent, rpc.kv);

  // The RPC dispatch loop is running via the readline event listener.
  // Keep the process alive — it exits via process.exit(0) on shutdown message.
  await new Promise<never>(() => {
    // intentionally never resolves
  });
}
