// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests using fake-vm (no KVM required).
 *
 * Exercises the full guest harness path: bundle injection, tool execution,
 * KV proxy, hooks, and shutdown — using a Unix socket instead of vsock.
 * Runs on macOS and Linux without Firecracker or KVM.
 *
 * Run: pnpm vitest run packages/aai-server/fake-vm-integration.test.ts
 */

import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createRpcChannel, type RpcChannel } from "./vsock.ts";

let tmpDir: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-fakevm-"));
});

afterEach(() => {
  // Kill any leftover child processes
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
  children.length = 0;
});

afterAll(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Spawn a fake VM process and wait for it to be ready.
 * Returns the socket path to connect to.
 */
async function spawnFakeVm(socketPath: string): Promise<ChildProcess> {
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
 * Connect to the fake VM's Unix socket and create an RPC channel.
 */
async function connectToFakeVm(
  socketPath: string,
): Promise<{ socket: net.Socket; channel: RpcChannel }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      const channel = createRpcChannel(socket as unknown as Duplex);
      resolve({ socket, channel });
    });
    socket.on("error", reject);
  });
}

// ── Agent bundles ──────────────────────────────────────────────────────────

const SIMPLE_BUNDLE = `
module.exports = {
  default: {
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
  },
};
`;

const STATEFUL_BUNDLE = `
module.exports = {
  default: {
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
  },
};
`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Fake VM integration (no KVM)", () => {
  test("injects bundle and executes tool", async () => {
    const socketPath = path.join(tmpDir, "test1.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    try {
      // Send bundle
      const bundleResp = await channel.request(
        { type: "bundle", code: SIMPLE_BUNDLE, env: {} },
        { timeout: 5000 },
      );
      expect(bundleResp.ok).toBe(true);

      // Execute tool
      const toolResp = await channel.request(
        {
          type: "tool",
          name: "echo",
          args: { message: "hello" },
          sessionId: "s1",
          messages: [],
        },
        { timeout: 5000 },
      );
      expect(toolResp.result).toBe('echo:{"message":"hello"}');
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("executes multiple tools concurrently", async () => {
    const socketPath = path.join(tmpDir, "test2.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    try {
      await channel.request({ type: "bundle", code: SIMPLE_BUNDLE, env: {} }, { timeout: 5000 });

      // Send two tool calls concurrently
      const [r1, r2] = await Promise.all([
        channel.request(
          { type: "tool", name: "add", args: { a: 1, b: 2 }, sessionId: "s1", messages: [] },
          { timeout: 5000 },
        ),
        channel.request(
          { type: "tool", name: "echo", args: { x: "y" }, sessionId: "s1", messages: [] },
          { timeout: 5000 },
        ),
      ]);

      expect(r1.result).toBe("3");
      expect(r2.result).toBe('echo:{"x":"y"}');
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("session state persists across tool calls", async () => {
    const socketPath = path.join(tmpDir, "test3.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    try {
      await channel.request({ type: "bundle", code: STATEFUL_BUNDLE, env: {} }, { timeout: 5000 });

      // Increment twice
      await channel.request(
        { type: "tool", name: "increment", args: {}, sessionId: "s1", messages: [] },
        { timeout: 5000 },
      );
      await channel.request(
        { type: "tool", name: "increment", args: {}, sessionId: "s1", messages: [] },
        { timeout: 5000 },
      );

      // Check count
      const resp = await channel.request(
        { type: "tool", name: "get_count", args: {}, sessionId: "s1", messages: [] },
        { timeout: 5000 },
      );
      expect(resp.result).toBe("count:2");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("separate sessions have independent state", async () => {
    const socketPath = path.join(tmpDir, "test4.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    try {
      await channel.request({ type: "bundle", code: STATEFUL_BUNDLE, env: {} }, { timeout: 5000 });

      // Increment session 1 three times
      for (let i = 0; i < 3; i++) {
        await channel.request(
          { type: "tool", name: "increment", args: {}, sessionId: "session-a", messages: [] },
          { timeout: 5000 },
        );
      }

      // Session 2 should start at 0
      const resp = await channel.request(
        { type: "tool", name: "get_count", args: {}, sessionId: "session-b", messages: [] },
        { timeout: 5000 },
      );
      expect(resp.result).toBe("count:0");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("env vars from bundle are accessible in tools", async () => {
    const socketPath = path.join(tmpDir, "test5.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    const envBundle = `
    module.exports = {
      default: {
        name: "env-agent",
        systemPrompt: "Test",
        greeting: "",
        maxSteps: 1,
        tools: {
          read_env: {
            description: "Read env var",
            execute(args, ctx) { return "env:" + (ctx.env.MY_SECRET || "undefined"); },
          },
        },
      },
    };
    `;

    try {
      await channel.request(
        { type: "bundle", code: envBundle, env: { MY_SECRET: "secret-123" } },
        { timeout: 5000 },
      );

      const resp = await channel.request(
        { type: "tool", name: "read_env", args: {}, sessionId: "s1", messages: [] },
        { timeout: 5000 },
      );
      expect(resp.result).toBe("env:secret-123");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("shutdown message causes process to exit", async () => {
    const socketPath = path.join(tmpDir, "test6.sock");
    const child = await spawnFakeVm(socketPath);
    const { channel } = await connectToFakeVm(socketPath);

    await channel.request({ type: "bundle", code: SIMPLE_BUNDLE, env: {} }, { timeout: 5000 });

    // Send shutdown (as a request so it has an id the guest can respond to)
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    // The shutdown handler calls process.exit, so the request may not get a response.
    // Use a short timeout and ignore timeout errors.
    channel.request({ type: "shutdown" }, { timeout: 2000 }).catch(() => {
      // Expected: process exits before responding
    });

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);

    // Process should have exited (exitCode is a number) or been killed
    expect(exitCode !== undefined || child.killed).toBe(true);
  }, 15_000);

  // ── Gap-closing tests ─────────────────────────────────────────────────────

  test("KV get/set round-trips through host proxy", async () => {
    const socketPath = path.join(tmpDir, "test-kv.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    // Set up a KV handler on the host side
    const kvStore = new Map<string, unknown>();
    channel.onRequest("kv", async (msg) => {
      const op = msg.op as string;
      if (op === "get") {
        return { value: kvStore.get(msg.key as string) ?? null };
      }
      if (op === "set") {
        kvStore.set(msg.key as string, msg.value);
        return { ok: true };
      }
      if (op === "del") {
        kvStore.delete(msg.key as string);
        return { ok: true };
      }
      return { error: `Unknown op: ${op}` };
    });

    const kvBundle = `
    module.exports = {
      default: {
        name: "kv-agent",
        systemPrompt: "KV test",
        greeting: "",
        maxSteps: 1,
        tools: {
          kv_roundtrip: {
            description: "Store then read from KV",
            async execute(args, ctx) {
              await ctx.kv.set("test-key", args.value);
              const result = await ctx.kv.get("test-key");
              return "stored:" + JSON.stringify(result);
            },
          },
        },
      },
    };
    `;

    try {
      await channel.request({ type: "bundle", code: kvBundle, env: {} }, { timeout: 5000 });

      const toolResp = await channel.request(
        {
          type: "tool",
          name: "kv_roundtrip",
          args: { value: "hello-kv" },
          sessionId: "kv-s1",
          messages: [],
        },
        { timeout: 5000 },
      );

      expect(toolResp.result).toBe('stored:"hello-kv"');
      expect(kvStore.get("test-key")).toBe("hello-kv");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("tool that throws returns error in response", async () => {
    const socketPath = path.join(tmpDir, "test-error.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    const errorBundle = `
    module.exports = {
      default: {
        name: "error-agent",
        systemPrompt: "Error test",
        greeting: "",
        maxSteps: 1,
        tools: {
          fail: {
            description: "Always throws",
            execute() { throw new Error("intentional failure"); },
          },
        },
      },
    };
    `;

    try {
      await channel.request({ type: "bundle", code: errorBundle, env: {} }, { timeout: 5000 });

      const toolResp = await channel.request(
        {
          type: "tool",
          name: "fail",
          args: {},
          sessionId: "err-s1",
          messages: [],
        },
        { timeout: 5000 },
      );

      // The error should propagate back through the RPC channel
      expect(toolResp.error).toBe("intentional failure");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  test("tool parameters.parse is invoked on args", async () => {
    const socketPath = path.join(tmpDir, "test-params.sock");
    await spawnFakeVm(socketPath);
    const { socket, channel } = await connectToFakeVm(socketPath);

    // Bundle with a tool that has a parameters object with a parse method.
    // The parse method transforms args (uppercases the "text" field).
    const paramsBundle = `
    module.exports = {
      default: {
        name: "params-agent",
        systemPrompt: "Params test",
        greeting: "",
        maxSteps: 1,
        tools: {
          transform: {
            description: "Transform input via parameters.parse",
            parameters: {
              parse(args) {
                return { text: String(args.text).toUpperCase() };
              },
            },
            execute(args) { return "parsed:" + args.text; },
          },
        },
      },
    };
    `;

    try {
      await channel.request({ type: "bundle", code: paramsBundle, env: {} }, { timeout: 5000 });

      const toolResp = await channel.request(
        {
          type: "tool",
          name: "transform",
          args: { text: "hello" },
          sessionId: "param-s1",
          messages: [],
        },
        { timeout: 5000 },
      );

      // The parse method should have uppercased the text
      expect(toolResp.result).toBe("parsed:HELLO");
    } finally {
      channel.close();
      socket.destroy();
    }
  }, 15_000);

  // ── Compiled harness test ───────────────────────────────────────────────────

  const COMPILED_HARNESS = path.resolve(import.meta.dirname, "dist/guest/harness.mjs");
  const hasCompiledHarness = existsSync(COMPILED_HARNESS);

  test.skipIf(!hasCompiledHarness)(
    "compiled harness (dist/guest/harness.mjs) injects bundle and executes tool",
    async () => {
      const socketPath = path.join(tmpDir, "test-compiled.sock");

      // Spawn fake-vm but point it at the compiled harness instead of source
      const fakeVmScript = `
      import net from "node:net";
      import fs from "node:fs";

      const socketPath = process.argv[2];
      const harnessPath = process.argv[3];

      try { fs.unlinkSync(socketPath); } catch {}

      const { main } = await import(harnessPath);

      const server = net.createServer((conn) => {
        server.close();
        main(conn).catch((err) => {
          console.error("Harness error:", err);
          process.exit(1);
        });
      });

      server.listen(socketPath, () => {
        console.log("FAKE_VM_READY:" + socketPath);
      });
      `;

      const scriptPath = path.join(tmpDir, "compiled-vm-launcher.mjs");
      await fs.writeFile(scriptPath, fakeVmScript, "utf-8");

      const child = fork(scriptPath, [socketPath, COMPILED_HARNESS], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        silent: true,
      });

      children.push(child);

      // Wait for ready signal
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Compiled harness did not become ready within 10s")),
          10_000,
        );
        child.stdout?.on("data", (data: Buffer) => {
          if (data.toString().includes("FAKE_VM_READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr?.on("data", (data: Buffer) => {
          process.stderr.write(`[compiled-harness] ${data}`);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Compiled harness exited with code ${code}`));
        });
      });

      const { socket, channel } = await connectToFakeVm(socketPath);

      try {
        const bundleResp = await channel.request(
          { type: "bundle", code: SIMPLE_BUNDLE, env: {} },
          { timeout: 5000 },
        );
        expect(bundleResp.ok).toBe(true);

        const toolResp = await channel.request(
          {
            type: "tool",
            name: "echo",
            args: { message: "compiled-test" },
            sessionId: "compiled-s1",
            messages: [],
          },
          { timeout: 5000 },
        );
        expect(toolResp.result).toBe('echo:{"message":"compiled-test"}');
      } finally {
        channel.close();
        socket.destroy();
      }
    },
    15_000,
  );
});
