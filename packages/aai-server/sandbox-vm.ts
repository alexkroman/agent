// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by gVisor OCI containers (Linux) or plain
 * child processes (macOS dev mode).
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to.
 * Communication with the guest uses vscode-jsonrpc over stdio pipes.
 */

import { type ChildProcess, fork } from "node:child_process";
import type { Storage, StorageValue } from "unstorage";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { createGvisorSandbox, isGvisorAvailable } from "./gvisor.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxHandle = {
  conn: MessageConnection;
  shutdown(): Promise<void>;
};

export type SandboxVmOptions = {
  slug: string;
  workerCode: string;
  agentEnv: Record<string, string>;
  harnessPath: string;
  kvStorage?: Storage;
  kvPrefix?: string;
};

// ── Shared setup ─────────────────────────────────────────────────────────────

/**
 * After establishing a jsonrpc connection, sends the bundle message and
 * registers the KV handler. Returns the configured SandboxHandle.
 */
async function configureSandbox(
  conn: MessageConnection,
  opts: SandboxVmOptions,
  cleanup: () => Promise<void>,
): Promise<SandboxHandle> {
  conn.listen();

  // Host serves guest KV requests
  if (opts.kvStorage && opts.kvPrefix) {
    const storage = opts.kvStorage;
    const prefix = opts.kvPrefix;
    conn.onRequest(
      "kv/get",
      async (p: { key: string }) => await storage.getItem(`${prefix}:${p.key}`),
    );
    conn.onRequest("kv/set", async (p: { key: string; value: unknown }) => {
      await storage.setItem(`${prefix}:${p.key}`, p.value as StorageValue);
    });
    conn.onRequest(
      "kv/del",
      async (p: { key: string }) => await storage.removeItem(`${prefix}:${p.key}`),
    );
  }

  // Send bundle to guest
  await conn.sendRequest("bundle/load", {
    code: opts.workerCode,
    env: opts.agentEnv,
  });

  return {
    conn,
    async shutdown() {
      void conn.sendNotification("shutdown");
      conn.dispose();
      await cleanup();
    },
  };
}

// ── Connection helper ────────────────────────────────────────────────────────

function createConnection(child: ChildProcess): MessageConnection {
  if (!(child.stdout && child.stdin)) {
    throw new Error("Child process missing stdio");
  }
  return createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
}

// ── Dev sandbox (macOS / non-gVisor) ─────────────────────────────────────────

/**
 * Creates a sandbox by forking the guest harness as a child process.
 * Communication uses stdio pipes with vscode-jsonrpc.
 */
export async function createDevSandbox(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const child: ChildProcess = fork(opts.harnessPath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  return configureSandbox(createConnection(child), opts, async () => {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

// ── gVisor sandbox (Linux production) ────────────────────────────────────────

/**
 * Creates a sandbox backed by a gVisor OCI container.
 */
export async function createGvisorSandboxHandle(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const gvisor = createGvisorSandbox({
    slug: opts.slug,
    harnessPath: opts.harnessPath,
  });
  return configureSandbox(createConnection(gvisor.process), opts, () => gvisor.cleanup());
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a sandbox using the best available backend:
 * - gVisor OCI container on Linux (production)
 * - Child process on macOS (dev only — no isolation)
 *
 * In production (NODE_ENV=production), gVisor is REQUIRED. The server
 * will refuse to start without it to prevent running untrusted agent
 * code without sandbox isolation.
 */
export async function createSandboxVm(opts: SandboxVmOptions): Promise<SandboxHandle> {
  if (isGvisorAvailable()) return createGvisorSandboxHandle(opts);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "gVisor (runsc) is required in production but not found on PATH. " +
        "Install runsc: https://gvisor.dev/docs/user_guide/install/ — " +
        "Running untrusted agent code without sandbox isolation is not allowed.",
    );
  }

  console.warn(
    "[sandbox] WARNING: gVisor not available. Running without sandbox isolation (dev mode only).",
  );
  return createDevSandbox(opts);
}

// ── Internal exports for testing ─────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  configureSandbox,
  createConnection,
};
