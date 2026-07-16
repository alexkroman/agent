// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared helpers for the fake-vm integration test files
 * (fake-vm-integration.test.ts, fake-vm-integration-rpc.test.ts).
 *
 * Provides the Deno availability guard, fake-VM process spawning over a
 * Unix socket, NDJSON connection setup, and the shared agent bundles.
 */

import { type ChildProcess, execFileSync, fork } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";

export function isDenoAvailable(): boolean {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const hasDeno = isDenoAvailable();

/**
 * Child processes spawned via spawnFakeVm (or directly by tests). Test files
 * kill and clear these in their own afterEach hook. Vitest isolates module
 * registries per test file, so this array is per-file.
 */
export const children: ChildProcess[] = [];

/**
 * Spawn a fake VM process and wait for it to be ready.
 * Returns the socket path to connect to.
 */
export async function spawnFakeVm(socketPath: string): Promise<ChildProcess> {
  const fakeVmPath = path.resolve(import.meta.dirname, "guest/fake-vm.ts");

  const child = fork(fakeVmPath, [socketPath], {
    execArgv: ["--experimental-strip-types", "--conditions", "@dev/source"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    silent: true,
  });

  children.push(child);

  // Wait for "FAKE_VM_READY" on stdout
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fake VM did not become ready within 10s")),
      10_000,
    );

    child.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("FAKE_VM_READY")) {
        clearTimeout(timer);
        resolve();
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      // Log stderr for debugging
      process.stderr.write(`[fake-vm] ${data}`);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fake VM exited with code ${code}`));
    });
  });

  return child;
}

/**
 * Connect to the fake VM's Unix socket and create an NDJSON connection.
 */
export async function connectToFakeVm(
  socketPath: string,
): Promise<{ socket: net.Socket; conn: NdjsonConnection }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      const conn = createNdjsonConnection(socket, socket);
      conn.listen();
      resolve({ socket, conn });
    });
    socket.on("error", reject);
  });
}

// ── Agent bundles ──────────────────────────────────────────────────────────

export const SIMPLE_BUNDLE = `
export default {
  name: "test-agent",
  systemPrompt: "Test",
  greeting: "Hello",
  maxSteps: 5,
  tools: {
    echo: {
      description: "Echo input",
      execute(args) { return "echo:" + JSON.stringify(args); },
    },
    add: {
      description: "Add two numbers",
      execute(args) { return String(Number(args.a) + Number(args.b)); },
    },
  },
};
`;

export const STATEFUL_BUNDLE = `
export default {
  name: "stateful-agent",
  systemPrompt: "Test",
  greeting: "",
  state: () => ({ count: 0 }),
  maxSteps: 5,
  tools: {
    increment: {
      description: "Increment counter",
      execute(args, ctx) {
        ctx.state.count++;
        return "count:" + ctx.state.count;
      },
    },
    get_count: {
      description: "Get counter value",
      execute(args, ctx) {
        return "count:" + ctx.state.count;
      },
    },
  },
};
`;
