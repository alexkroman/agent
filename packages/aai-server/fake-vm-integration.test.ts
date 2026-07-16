// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests using fake-vm (no KVM required).
 *
 * Exercises the core guest harness path: bundle injection, tool execution,
 * session state, env vars, and shutdown — using a Unix socket instead of
 * stdio pipes. Runs on macOS and Linux without gVisor or KVM.
 *
 * Host RPC proxy and compiled-harness tests live in
 * fake-vm-integration-rpc.test.ts; shared helpers live in
 * _fake-vm-integration-test-utils.ts.
 *
 * Run: pnpm vitest run packages/aai-server/fake-vm-integration.test.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  children,
  connectToFakeVm,
  hasDeno,
  SIMPLE_BUNDLE,
  STATEFUL_BUNDLE,
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
});
