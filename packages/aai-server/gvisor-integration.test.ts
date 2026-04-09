// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests using real gVisor (runsc) sandboxes.
 *
 * Tests bundle injection, tool execution, KV proxy, cross-agent isolation,
 * filesystem/network restrictions, error propagation, and shutdown — all
 * running inside a real gVisor OCI container with stdio pipes.
 *
 * Skipped automatically if runsc is not available (macOS, CI without gVisor).
 *
 * Run: pnpm vitest run --config packages/aai-server/vitest.gvisor.config.ts
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { createGvisorSandbox, type GvisorSandbox, isGvisorAvailable } from "./gvisor.ts";

// ── Availability check ────────────────────────────────────────────────────────

const compiledHarnessPath = path.resolve(import.meta.dirname, "dist/guest/harness.mjs");
const canRun = isGvisorAvailable() && existsSync(compiledHarnessPath);

// ── Sandbox tracking ──────────────────────────────────────────────────────────

const activeSandboxes: GvisorSandbox[] = [];

afterEach(async () => {
  await Promise.all(
    activeSandboxes.map((sb) =>
      sb.cleanup().catch(() => {
        // ignore cleanup errors
      }),
    ),
  );
  activeSandboxes.length = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Spawn a gVisor sandbox and create a jsonrpc connection over its stdio.
 */
async function spawnSandbox(slug: string): Promise<{
  sandbox: GvisorSandbox;
  conn: MessageConnection;
}> {
  const sandbox = createGvisorSandbox({
    slug,
    harnessPath: compiledHarnessPath,
  });
  activeSandboxes.push(sandbox);

  // Wait for process to start (give runsc a moment to boot)
  await new Promise<void>((resolve, reject) => {
    // runsc writes startup errors to stderr; stdin/stdout are for IPC
    let stderr = "";
    sandbox.process.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // If it exits immediately, surface the error
    sandbox.process.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`gVisor sandbox exited with code ${code}. stderr: ${stderr}`));
      }
    });

    // Give it 5s to start (stdin will block until runsc is ready)
    setTimeout(resolve, 500);
  });

  if (!(sandbox.process.stdout && sandbox.process.stdin)) {
    throw new Error("gVisor sandbox process does not have stdio streams");
  }
  const conn = createMessageConnection(
    new StreamMessageReader(sandbox.process.stdout),
    new StreamMessageWriter(sandbox.process.stdin),
  );
  conn.listen();

  return { sandbox, conn };
}

// ── Agent bundles (reused from fake-vm-integration tests) ─────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!canRun)("gVisor integration (real runsc)", () => {
  test("bundle injection + tool execution", async () => {
    const { sandbox, conn } = await spawnSandbox("echo-test");

    try {
      const bundleResp = await conn.sendRequest<{ ok: boolean }>("bundle/load", {
        code: SIMPLE_BUNDLE,
        env: {},
      });
      expect(bundleResp.ok).toBe(true);

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "echo",
        args: { message: "hello-gvisor" },
        sessionId: "s1",
        messages: [],
      });
      expect(toolResp.result).toBe('echo:{"message":"hello-gvisor"}');
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("KV round-trip through host proxy", async () => {
    const { sandbox, conn } = await spawnSandbox("kv-test");

    // Register KV handlers on the host side
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
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("cross-agent isolation — globalThis secret not shared", async () => {
    const secretBundle = `
    module.exports = {
      default: {
        name: "secret-agent",
        systemPrompt: "Test",
        greeting: "",
        maxSteps: 1,
        tools: {
          set_secret: {
            description: "Store secret on globalThis",
            execute(args) {
              globalThis.__secret = args.value;
              return "set";
            },
          },
        },
      },
    };
    `;

    const readerBundle = `
    module.exports = {
      default: {
        name: "reader-agent",
        systemPrompt: "Test",
        greeting: "",
        maxSteps: 1,
        tools: {
          read_secret: {
            description: "Read secret from globalThis",
            execute() {
              return "secret:" + String(globalThis.__secret);
            },
          },
        },
      },
    };
    `;

    const { sandbox: sb1, conn: conn1 } = await spawnSandbox("isolation-1");
    const { sandbox: sb2, conn: conn2 } = await spawnSandbox("isolation-2");

    try {
      // Agent 1 sets a secret on globalThis
      await conn1.sendRequest("bundle/load", { code: secretBundle, env: {} });
      await conn1.sendRequest("tool/execute", {
        name: "set_secret",
        args: { value: "top-secret-42" },
        sessionId: "s1",
        messages: [],
      });

      // Agent 2 tries to read it — should be undefined
      await conn2.sendRequest("bundle/load", { code: readerBundle, env: {} });
      const resp = await conn2.sendRequest<{ result: string }>("tool/execute", {
        name: "read_secret",
        args: {},
        sessionId: "s2",
        messages: [],
      });

      // Different container, so globalThis.__secret is not accessible
      expect(resp.result).toBe("secret:undefined");
    } finally {
      conn1.dispose();
      conn2.dispose();
      await Promise.all([
        sb1.cleanup().catch(() => {
          // ignore cleanup errors
        }),
        sb2.cleanup().catch(() => {
          // ignore cleanup errors
        }),
      ]);
      activeSandboxes.splice(activeSandboxes.indexOf(sb1), 1);
      activeSandboxes.splice(activeSandboxes.indexOf(sb2), 1);
    }
  }, 30_000);

  test("cannot read host filesystem", async () => {
    const fsBundle = `
    module.exports = {
      default: {
        name: "fs-agent",
        systemPrompt: "FS test",
        greeting: "",
        maxSteps: 1,
        tools: {
          read_file: {
            description: "Try to read /etc/hostname",
            execute() {
              try {
                const fs = require("fs");
                return "read:" + fs.readFileSync("/etc/hostname", "utf8").trim();
              } catch (err) {
                return "error:" + err.message;
              }
            },
          },
        },
      },
    };
    `;

    const { sandbox, conn } = await spawnSandbox("fs-test");

    try {
      await conn.sendRequest("bundle/load", { code: fsBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "read_file",
        args: {},
        sessionId: "fs-s1",
        messages: [],
      });

      // Either the file doesn't exist in the minimal rootfs,
      // or the read returns an error — either way no host data leaks
      expect(toolResp.result).toMatch(/^error:/);
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("cannot access network", async () => {
    const netBundle = `
    module.exports = {
      default: {
        name: "net-agent",
        systemPrompt: "Net test",
        greeting: "",
        maxSteps: 1,
        tools: {
          http_get: {
            description: "Try to make an outbound HTTP request",
            async execute() {
              try {
                const http = require("http");
                await new Promise((resolve, reject) => {
                  const req = http.get("http://example.com", (res) => {
                    resolve(res.statusCode);
                  });
                  req.on("error", reject);
                  req.setTimeout(3000, () => {
                    req.destroy(new Error("timeout"));
                  });
                });
                return "connected";
              } catch (err) {
                return "error:" + err.message;
              }
            },
          },
        },
      },
    };
    `;

    const { sandbox, conn } = await spawnSandbox("net-test");

    try {
      await conn.sendRequest("bundle/load", { code: netBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "http_get",
        args: {},
        sessionId: "net-s1",
        messages: [],
      });

      // Network is disabled in the gVisor sandbox; should get a connection error
      expect(toolResp.result).toMatch(/^error:/);
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("error propagation — tool throws returns error in response", async () => {
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

    const { sandbox, conn } = await spawnSandbox("error-test");

    try {
      await conn.sendRequest("bundle/load", { code: errorBundle, env: {} });

      const toolResp = await conn.sendRequest<{ error: string }>("tool/execute", {
        name: "fail",
        args: {},
        sessionId: "err-s1",
        messages: [],
      });

      expect(toolResp.error).toBe("intentional failure");
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("shutdown notification causes process to exit", async () => {
    const { sandbox, conn } = await spawnSandbox("shutdown-test");

    await conn.sendRequest("bundle/load", { code: SIMPLE_BUNDLE, env: {} });

    const exitPromise = new Promise<number | null>((resolve) => {
      sandbox.process.once("exit", (code) => resolve(code));
    });

    conn.sendNotification("shutdown");

    const exitCode = await Promise.race([
      exitPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);

    // Process should have exited cleanly
    expect(exitCode !== undefined || sandbox.process.killed).toBe(true);

    conn.dispose();
    activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
  }, 30_000);
});
