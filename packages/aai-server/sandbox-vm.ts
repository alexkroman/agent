// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by Firecracker microVMs (Linux) or plain
 * child processes (macOS dev mode).
 *
 * Provides the `SandboxHandle` abstraction that `sandbox.ts` delegates to,
 * replacing the secure-exec V8 isolate layer. Communication with the guest
 * uses the newline-delimited JSON RPC channel from `vsock.ts`.
 */

import { type ChildProcess, fork } from "node:child_process";
import net from "node:net";
import { Duplex } from "node:stream";
import type { Storage } from "unstorage";
import { VM_MEMORY_MIB, VM_VCPU_COUNT } from "./constants.ts";
import { type FirecrackerVm, isFirecrackerAvailable, startVm } from "./firecracker.ts";
import { createRpcChannel, type RpcChannel } from "./vsock.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxHandle = {
  request(
    msg: { type: string; [key: string]: unknown },
    opts: { timeout: number },
  ): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
};

export type SandboxVmOptions = {
  slug: string;
  workerCode: string;
  agentEnv: Record<string, string>;
  // Firecracker-specific (optional for dev mode)
  vmlinuxPath?: string;
  initrdPath?: string;
  snapshotStatePath?: string;
  snapshotMemPath?: string;
  guestCid?: number;
  vsockUdsPath?: string;
  // Dev-mode
  harnessPath?: string;
  // KV storage
  kvStorage?: Storage;
  kvPrefix?: string;
};

// ── KV request handler ───────────────────────────────────────────────────────

/**
 * Serves KV proxy requests from the guest. The guest sends KV operations
 * over the RPC channel and this handler fulfills them against the host-side
 * unstorage instance.
 */
async function handleKvRequest(
  msg: Record<string, unknown>,
  storage: Storage,
  prefix: string,
): Promise<Record<string, unknown>> {
  const op = msg.op as string;
  const key = msg.key as string | undefined;

  switch (op) {
    case "get": {
      const value = await storage.getItem(`${prefix}:${key}`);
      return { value };
    }
    case "set": {
      await storage.setItem(`${prefix}:${key}`, msg.value);
      return { ok: true };
    }
    case "del": {
      await storage.removeItem(`${prefix}:${key}`);
      return { ok: true };
    }
    case "mget": {
      const keys = (msg.keys ?? []) as string[];
      const values = await Promise.all(keys.map((k) => storage.getItem(`${prefix}:${k}`)));
      return { values };
    }
    default:
      return { error: `Unknown KV op: ${op}` };
  }
}

// ── Shared setup ─────────────────────────────────────────────────────────────

const BUNDLE_TIMEOUT_MS = 10_000;

/**
 * After establishing an RPC channel, sends the bundle message and registers
 * the KV handler. Returns the configured SandboxHandle.
 */
async function configureSandbox(
  channel: RpcChannel,
  opts: SandboxVmOptions,
  cleanup: () => Promise<void>,
): Promise<SandboxHandle> {
  // Register KV handler if storage is provided
  if (opts.kvStorage && opts.kvPrefix) {
    const storage = opts.kvStorage;
    const prefix = opts.kvPrefix;
    channel.onRequest("kv", async (msg) => handleKvRequest(msg, storage, prefix));
  }

  // Send bundle message and wait for acknowledgement
  await channel.request(
    { type: "bundle", code: opts.workerCode, env: opts.agentEnv },
    { timeout: BUNDLE_TIMEOUT_MS },
  );

  return {
    async request(msg, requestOpts) {
      const response = await channel.request(msg, { timeout: requestOpts.timeout });
      return response as Record<string, unknown>;
    },
    async shutdown() {
      channel.close();
      await cleanup();
    },
  };
}

// ── Dev sandbox (macOS / non-Firecracker) ────────────────────────────────────

/**
 * Creates a sandbox by forking the guest harness as a child process.
 * Communication uses stdio pipes wrapped in a Duplex stream.
 */
export async function createDevSandbox(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const harnessPath = opts.harnessPath;
  if (!harnessPath) {
    throw new Error("harnessPath is required for dev sandbox");
  }

  const child: ChildProcess = fork(harnessPath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  if (!(child.stdin && child.stdout)) {
    child.kill();
    throw new Error("Failed to get stdio streams from child process");
  }

  // Create a Duplex stream that reads from child stdout and writes to child stdin
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const stream = new Duplex({
    read() {
      // Data is pushed from the child.stdout pipe event below
    },
    write(chunk, encoding, callback) {
      childStdin.write(chunk, encoding, callback);
    },
    final(callback) {
      childStdin.end(callback);
    },
  });

  childStdout.on("data", (chunk: Buffer) => {
    stream.push(chunk);
  });

  childStdout.on("end", () => {
    stream.push(null);
  });

  const channel = createRpcChannel(stream);

  return configureSandbox(channel, opts, async () => {
    child.kill("SIGTERM");
    // Give the child a brief moment to exit gracefully, then force-kill
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

// ── Firecracker sandbox (Linux production) ───────────────────────────────────

/**
 * Creates a sandbox backed by a Firecracker microVM.
 * Restores a VM from snapshot, connects via vsock UDS, and establishes
 * the RPC channel.
 */
export async function createFirecrackerSandbox(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const vmlinuxPath = opts.vmlinuxPath;
  const initrdPath = opts.initrdPath;
  const snapshotStatePath = opts.snapshotStatePath;
  const snapshotMemPath = opts.snapshotMemPath;
  const guestCid = opts.guestCid;
  const vsockUdsPath = opts.vsockUdsPath;

  if (!(vmlinuxPath && initrdPath && snapshotStatePath && snapshotMemPath)) {
    throw new Error("Firecracker paths (vmlinux, initrd, snapshot state/mem) are required");
  }
  if (guestCid === undefined || !vsockUdsPath) {
    throw new Error("guestCid and vsockUdsPath are required for Firecracker sandbox");
  }

  const vm: FirecrackerVm = await startVm({
    vmlinuxPath,
    initrdPath,
    snapshotStatePath,
    snapshotMemPath,
    vcpuCount: VM_VCPU_COUNT,
    memSizeMib: VM_MEMORY_MIB,
    guestCid,
    vsockUdsPath,
  });

  // Connect to the guest via the vsock UDS path
  const socket: net.Socket = await new Promise<net.Socket>((resolve, reject) => {
    const conn = net.connect(vsockUdsPath, () => {
      resolve(conn);
    });
    conn.on("error", (err) => {
      reject(new Error(`Failed to connect to guest vsock: ${err.message}`));
    });
  });

  const channel = createRpcChannel(socket as unknown as Duplex);

  return configureSandbox(channel, opts, async () => {
    socket.destroy();
    await vm.kill();
  });
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a sandbox using the best available backend:
 * - Firecracker microVM on Linux when available
 * - Child process (dev mode) otherwise
 */
export async function createSandboxVm(opts: SandboxVmOptions): Promise<SandboxHandle> {
  if (isFirecrackerAvailable()) {
    return createFirecrackerSandbox(opts);
  }
  return createDevSandbox(opts);
}

// ── Internal exports for testing ─────────────────────────────────────────────

/** @internal Exposed for testing only. */
export const _internals = {
  handleKvRequest,
};
