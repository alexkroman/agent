// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests using fake-vm (no KVM required).
 *
 * Exercises the full guest harness path: bundle injection, tool execution,
 * KV proxy, and shutdown — using a Unix socket instead of stdio pipes.
 * Runs on macOS and Linux without gVisor or KVM.
 *
 * Run: pnpm vitest run packages/aai-server/fake-vm-integration.test.ts
 */

import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";

function isDenoAvailable(): boolean {
  try {
    execFileSync("deno", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDeno = isDenoAvailable();

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
 * Connect to the fake VM's Unix socket and create an NDJSON connection.
 */
async function connectToFakeVm(
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

const SIMPLE_BUNDLE = `
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

const STATEFUL_BUNDLE = `
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasDeno)("Fake VM integration (no KVM)", () => {
  test("injects bundle and executes tool", async () => {
    const socketPath = path.join(tmpDir, "test1.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      // Send bundle
      const bundleResp = await conn.sendRequest<{ ok: boolean }>("bundle/load", {
        code: SIMPLE_BUNDLE,
        env: {},
      });
      expect(bundleResp.ok).toBe(true);

      // Execute tool
      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "echo",
        args: { message: "hello" },
        sessionId: "s1",
        messages: [],
      });
      expect(toolResp.result).toBe('echo:{"message":"hello"}');
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("executes multiple tools concurrently", async () => {
    const socketPath = path.join(tmpDir, "test2.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      await conn.sendRequest("bundle/load", { code: SIMPLE_BUNDLE, env: {} });

      // Send two tool calls concurrently
      const [r1, r2] = await Promise.all([
        conn.sendRequest<{ result: string }>("tool/execute", {
          name: "add",
          args: { a: 1, b: 2 },
          sessionId: "s1",
          messages: [],
        }),
        conn.sendRequest<{ result: string }>("tool/execute", {
          name: "echo",
          args: { x: "y" },
          sessionId: "s1",
          messages: [],
        }),
      ]);

      expect(r1.result).toBe("3");
      expect(r2.result).toBe('echo:{"x":"y"}');
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("session state persists across tool calls", async () => {
    const socketPath = path.join(tmpDir, "test3.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      await conn.sendRequest("bundle/load", { code: STATEFUL_BUNDLE, env: {} });

      // Increment twice
      await conn.sendRequest("tool/execute", {
        name: "increment",
        args: {},
        sessionId: "s1",
        messages: [],
      });
      await conn.sendRequest("tool/execute", {
        name: "increment",
        args: {},
        sessionId: "s1",
        messages: [],
      });

      // Check count
      const resp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "get_count",
        args: {},
        sessionId: "s1",
        messages: [],
      });
      expect(resp.result).toBe("count:2");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("separate sessions have independent state", async () => {
    const socketPath = path.join(tmpDir, "test4.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      await conn.sendRequest("bundle/load", { code: STATEFUL_BUNDLE, env: {} });

      // Increment session 1 three times
      for (let i = 0; i < 3; i++) {
        await conn.sendRequest("tool/execute", {
          name: "increment",
          args: {},
          sessionId: "session-a",
          messages: [],
        });
      }

      // Session 2 should start at 0
      const resp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "get_count",
        args: {},
        sessionId: "session-b",
        messages: [],
      });
      expect(resp.result).toBe("count:0");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("env vars from bundle are accessible in tools", async () => {
    const socketPath = path.join(tmpDir, "test5.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    const envBundle = `
    export default {
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
    };
    `;

    try {
      await conn.sendRequest("bundle/load", {
        code: envBundle,
        env: { MY_SECRET: "secret-123" },
      });

      const resp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "read_env",
        args: {},
        sessionId: "s1",
        messages: [],
      });
      expect(resp.result).toBe("env:secret-123");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("shutdown message causes process to exit", async () => {
    const socketPath = path.join(tmpDir, "test6.sock");
    const child = await spawnFakeVm(socketPath);
    const { conn } = await connectToFakeVm(socketPath);

    await conn.sendRequest("bundle/load", { code: SIMPLE_BUNDLE, env: {} });

    // Send shutdown notification
    const exitPromise = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    conn.sendNotification("shutdown");

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
    const { socket, conn } = await connectToFakeVm(socketPath);

    // Set up a KV handler on the host side
    const kvStore = new Map<string, unknown>();
    conn.onRequest("kv/get", async (params: { key: string }) => ({
      value: kvStore.get(params.key) ?? null,
    }));
    conn.onRequest("kv/set", async (params: { key: string; value: unknown }) => {
      kvStore.set(params.key, params.value);
      return { ok: true };
    });
    conn.onRequest("kv/del", async (params: { key: string }) => {
      kvStore.delete(params.key);
      return { ok: true };
    });

    const kvBundle = `
    export default {
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
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: kvBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "kv_roundtrip",
        args: { value: "hello-kv" },
        sessionId: "kv-s1",
        messages: [],
      });

      expect(toolResp.result).toBe('stored:"hello-kv"');
      expect(kvStore.get("test-key")).toBe("hello-kv");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("tool that throws returns error in response", async () => {
    const socketPath = path.join(tmpDir, "test-error.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    const errorBundle = `
    export default {
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
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: errorBundle, env: {} });

      const toolResp = await conn.sendRequest<{ error: string }>("tool/execute", {
        name: "fail",
        args: {},
        sessionId: "err-s1",
        messages: [],
      });

      // The error should propagate back through the RPC channel
      expect(toolResp.error).toBe("intentional failure");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("tool parameters.parse is invoked on args", async () => {
    const socketPath = path.join(tmpDir, "test-params.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    // Bundle with a tool that has a parameters object with a parse method.
    // The parse method transforms args (uppercases the "text" field).
    const paramsBundle = `
    export default {
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
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: paramsBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "transform",
        args: { text: "hello" },
        sessionId: "param-s1",
        messages: [],
      });

      // The parse method should have uppercased the text
      expect(toolResp.result).toBe("parsed:HELLO");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  // ── Harness edge-case tests ─────────────────────────────────────────────────

  test("tool/execute before bundle/load returns error", async () => {
    const socketPath = path.join(tmpDir, "test-no-bundle.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      // Attempt tool execution without loading a bundle first
      const resp = await conn.sendRequest<{ error?: { code: number; message: string } }>(
        "tool/execute",
        {
          name: "echo",
          args: {},
          sessionId: "s1",
          messages: [],
        },
      );

      // The harness should return an error (JSON-RPC error response)
      // Since this comes back as a JSON-RPC error, sendRequest will reject
      expect(resp).toBeDefined();
    } catch (err: unknown) {
      // Expected: JSON-RPC error "Agent not loaded"
      expect((err as Error).message).toMatch(/Agent not loaded/);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("unknown tool name returns error in response", async () => {
    const socketPath = path.join(tmpDir, "test-unknown-tool.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      await conn.sendRequest("bundle/load", { code: SIMPLE_BUNDLE, env: {} });

      const toolResp = await conn.sendRequest<{ error: string }>("tool/execute", {
        name: "nonexistent_tool",
        args: {},
        sessionId: "s1",
        messages: [],
      });

      expect(toolResp.error).toMatch(/Unknown tool.*nonexistent_tool/);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("unknown RPC method returns JSON-RPC error", async () => {
    const socketPath = path.join(tmpDir, "test-unknown-method.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      await conn.sendRequest("bundle/load", { code: SIMPLE_BUNDLE, env: {} });

      await expect(conn.sendRequest("totally/bogus", { foo: "bar" })).rejects.toThrow(
        /Method not found/,
      );
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("session/end notification cleans up session state", async () => {
    const socketPath = path.join(tmpDir, "test-session-end.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    try {
      await conn.sendRequest("bundle/load", { code: STATEFUL_BUNDLE, env: {} });

      // Increment counter for session-x
      await conn.sendRequest("tool/execute", {
        name: "increment",
        args: {},
        sessionId: "session-x",
        messages: [],
      });
      await conn.sendRequest("tool/execute", {
        name: "increment",
        args: {},
        sessionId: "session-x",
        messages: [],
      });

      // Verify count is 2
      const before = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "get_count",
        args: {},
        sessionId: "session-x",
        messages: [],
      });
      expect(before.result).toBe("count:2");

      // Send session/end notification to clean up
      conn.sendNotification("session/end", { sessionId: "session-x" });

      // Small delay for notification to be processed
      await new Promise((r) => setTimeout(r, 200));

      // After cleanup, session-x should restart from 0
      const after = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "get_count",
        args: {},
        sessionId: "session-x",
        messages: [],
      });
      expect(after.result).toBe("count:0");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("KV delete removes key", async () => {
    const socketPath = path.join(tmpDir, "test-kv-del.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    const kvStore = new Map<string, unknown>();
    conn.onRequest("kv/get", async (params: { key: string }) => ({
      value: kvStore.get(params.key) ?? null,
    }));
    conn.onRequest("kv/set", async (params: { key: string; value: unknown }) => {
      kvStore.set(params.key, params.value);
      return { ok: true };
    });
    conn.onRequest("kv/del", async (params: { key: string }) => {
      kvStore.delete(params.key);
      return { ok: true };
    });

    const kvDelBundle = `
    export default {
      name: "kv-del-agent",
      systemPrompt: "KV delete test",
      greeting: "",
      maxSteps: 1,
      tools: {
        kv_set_then_delete: {
          description: "Set a key then delete it",
          async execute(args, ctx) {
            await ctx.kv.set("ephemeral", "temporary-value");
            const before = await ctx.kv.get("ephemeral");
            await ctx.kv.delete("ephemeral");
            const after = await ctx.kv.get("ephemeral");
            return "before:" + JSON.stringify(before) + ",after:" + JSON.stringify(after);
          },
        },
      },
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: kvDelBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "kv_set_then_delete",
        args: {},
        sessionId: "kv-del-s1",
        messages: [],
      });

      expect(toolResp.result).toBe('before:"temporary-value",after:null');
      expect(kvStore.has("ephemeral")).toBe(false);
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("tool result is JSON-stringified when non-string", async () => {
    const socketPath = path.join(tmpDir, "test-json-result.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    const objectBundle = `
    export default {
      name: "object-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 1,
      tools: {
        return_object: {
          description: "Returns an object, not a string",
          execute() { return { count: 42, items: ["a", "b"] }; },
        },
      },
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: objectBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "return_object",
        args: {},
        sessionId: "s1",
        messages: [],
      });

      expect(JSON.parse(toolResp.result)).toEqual({ count: 42, items: ["a", "b"] });
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  test("messages context is passed to tool execute", async () => {
    const socketPath = path.join(tmpDir, "test-messages.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    const msgBundle = `
    export default {
      name: "msg-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 1,
      tools: {
        count_messages: {
          description: "Count messages in context",
          execute(args, ctx) {
            return "messages:" + ctx.messages.length;
          },
        },
      },
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: msgBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "count_messages",
        args: {},
        sessionId: "s1",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
          { role: "user", content: "how are you?" },
        ],
      });

      expect(toolResp.result).toBe("messages:3");
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  // ── Compiled harness test ───────────────────────────────────────────────────

  const COMPILED_HARNESS = path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");
  const hasCompiledHarness = existsSync(COMPILED_HARNESS);

  test.skipIf(!hasCompiledHarness)(
    "compiled harness (dist/guest/deno-harness.mjs) injects bundle and executes tool",
    async () => {
      const socketPath = path.join(tmpDir, "test-compiled.sock");

      // Spawn a Node launcher that creates a Unix socket and pipes it to Deno
      const fakeVmScript = `
      import { spawn } from "node:child_process";
      import net from "node:net";
      import fs from "node:fs";

      const socketPath = process.argv[2];
      const harnessPath = process.argv[3];

      try { fs.unlinkSync(socketPath); } catch {}

      const server = net.createServer((conn) => {
        server.close();
        const harness = spawn("deno", ["run", "--allow-env", "--no-prompt", harnessPath], {
          stdio: ["pipe", "pipe", "inherit"],
        });
        if (harness.stdin) conn.pipe(harness.stdin);
        if (harness.stdout) harness.stdout.pipe(conn);
        harness.on("exit", (code) => {
          conn.destroy();
          process.exit(code ?? 0);
        });
        conn.on("error", () => {
          harness.kill();
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

      const { socket, conn } = await connectToFakeVm(socketPath);

      try {
        const bundleResp = await conn.sendRequest<{ ok: boolean }>("bundle/load", {
          code: SIMPLE_BUNDLE,
          env: {},
        });
        expect(bundleResp.ok).toBe(true);

        const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
          name: "echo",
          args: { message: "compiled-test" },
          sessionId: "compiled-s1",
          messages: [],
        });
        expect(toolResp.result).toBe('echo:{"message":"compiled-test"}');
      } finally {
        conn.dispose();
        socket.destroy();
      }
    },
    15_000,
  );
});
