// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests using fake-vm (no KVM required) — host RPC surface.
 *
 * Exercises the KV proxy, tool error propagation, parameters.parse,
 * ctx.send notifications, and the compiled harness bundle — using a Unix
 * socket instead of stdio pipes. Runs on macOS and Linux without gVisor
 * or KVM.
 *
 * Core bundle/tool/session tests live in fake-vm-integration.test.ts;
 * shared helpers live in _fake-vm-integration-test-utils.ts.
 *
 * Run: pnpm vitest run packages/aai-server/fake-vm-integration-rpc.test.ts
 */

import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  children,
  connectToFakeVm,
  hasDeno,
  SIMPLE_BUNDLE,
  spawnFakeVm,
} from "./_fake-vm-integration-test-utils.ts";

let tmpDir: string;

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

// ── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasDeno)("Fake VM integration (no KVM) — host RPC", () => {
  test("KV get/set round-trips through host proxy", async () => {
    const socketPath = path.join(tmpDir, "test-kv.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    // Set up a KV handler on the host side
    const kvStore = new Map<string, unknown>();
    // Match the production kv/get contract: return the value directly.
    conn.onRequest("kv/get", async (params: { key: string }) => kvStore.get(params.key) ?? null);
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

  test("ctx.send emits client/send notification to host", async () => {
    const socketPath = path.join(tmpDir, "test-send.sock");
    await spawnFakeVm(socketPath);
    const { socket, conn } = await connectToFakeVm(socketPath);

    const sendBundle = `
    export default {
      name: "send-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 1,
      tools: {
        emit_event: {
          description: "Emit a custom event via ctx.send",
          execute(args, ctx) {
            ctx.send("test_event", { value: 42 });
            return "sent";
          },
        },
      },
    };
    `;

    try {
      await conn.sendRequest("bundle/load", { code: sendBundle, env: {} });

      // Register handler to capture the client/send notification
      const received = new Promise<{ sessionId: string; event: string; data: unknown }>(
        (resolve) => {
          conn.onNotification("client/send", (params: unknown) => {
            resolve(params as { sessionId: string; event: string; data: unknown });
          });
        },
      );

      // Execute the tool — this triggers ctx.send inside the guest
      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "emit_event",
        args: {},
        sessionId: "send-s1",
        messages: [],
      });
      expect(toolResp.result).toBe("sent");

      // The notification should arrive
      const notification = await Promise.race([
        received,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("client/send notification not received within 5s")),
            5000,
          ),
        ),
      ]);

      expect(notification.sessionId).toBe("send-s1");
      expect(notification.event).toBe("test_event");
      expect(notification.data).toEqual({ value: 42 });
    } finally {
      conn.dispose();
      socket.destroy();
    }
  }, 15_000);

  // ── Compiled harness test ───────────────────────────────────────────────────

  const COMPILED_HARNESS = path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");
  const hasCompiledHarness = existsSync(COMPILED_HARNESS);

  describe.skipIf(!hasCompiledHarness)("compiled harness (dist/guest/deno-harness.mjs)", () => {
    test("injects bundle and executes tool", async () => {
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
    }, 15_000);
  });
});
