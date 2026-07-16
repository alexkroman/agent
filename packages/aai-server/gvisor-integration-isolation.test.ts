// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests using real gVisor (runsc) sandboxes — isolation
 * boundaries.
 *
 * Tests filesystem/network restrictions, tmpfs limits, and env-var
 * isolation inside a real gVisor OCI container with stdio pipes. Bundle
 * injection, KV proxy, cross-agent isolation, error propagation, and
 * shutdown tests live in gvisor-integration.test.ts.
 *
 * Skipped automatically if runsc is not available (macOS, CI without gVisor).
 *
 * Run: VITEST_PROFILE=gvisor VITEST_INCLUDE=packages/aai-server/gvisor-integration-isolation.test.ts pnpm vitest run -c vitest.slow.config.ts
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createGvisorSandbox, type GvisorSandbox, isGvisorAvailable } from "./gvisor.ts";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";

// ── Availability check ────────────────────────────────────────────────────────

const compiledHarnessPath = path.resolve(import.meta.dirname, "dist/guest/deno-harness.mjs");
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
 * Spawn a gVisor sandbox and create an NDJSON connection over its stdio.
 */
async function spawnSandbox(slug: string): Promise<{
  sandbox: GvisorSandbox;
  conn: NdjsonConnection;
}> {
  const sandbox = await createGvisorSandbox({
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
  const conn = createNdjsonConnection(sandbox.process.stdout, sandbox.process.stdin);
  conn.listen();

  return { sandbox, conn };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!canRun)("gVisor integration (real runsc) — isolation boundaries", () => {
  test("cannot read host filesystem", async () => {
    const fsBundle = `
    export default {
      name: "fs-agent",
      systemPrompt: "FS test",
      greeting: "",
      maxSteps: 1,
      tools: {
        read_file: {
          description: "Try to read /etc/hostname",
          execute() {
            try {
              const data = Deno.readTextFileSync("/etc/hostname");
              return "read:" + data.trim();
            } catch (err) {
              return "error:" + err.message;
            }
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

  test("host paths absent from minimal rootfs", async () => {
    const probeBundle = `
    export default {
      name: "probe-agent",
      systemPrompt: "Probe test",
      greeting: "",
      maxSteps: 1,
      tools: {
        probe_paths: {
          description: "Check which host paths exist in the rootfs",
          execute() {
            // Probe sensitive host paths that should NOT exist in the
            // minimal rootfs. Use Deno.statSync which doesn't require
            // --allow-read (it only checks existence, not content).
            const sensitive = [
              "/etc/hostname",
              "/etc/os-release",
              "/usr/bin/node",
              "/app",
              "/var/log",
              "/home",
              "/root",
            ];
            const found = [];
            for (const p of sensitive) {
              try {
                Deno.statSync(p);
                found.push(p);
              } catch {
                // Expected — path doesn't exist
              }
            }
            return found.length === 0 ? "none" : "found:" + found.join(",");
          },
        },
      },
    };
    `;

    const { sandbox, conn } = await spawnSandbox("rootfs-test");

    try {
      await conn.sendRequest("bundle/load", { code: probeBundle, env: {} });

      const toolResp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "probe_paths",
        args: {},
        sessionId: "rootfs-s1",
        messages: [],
      });

      // None of the sensitive host paths should exist in the sandbox
      expect(toolResp.result).toBe("none");
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("cannot access network", async () => {
    const netBundle = `
    export default {
      name: "net-agent",
      systemPrompt: "Net test",
      greeting: "",
      maxSteps: 1,
      tools: {
        http_get: {
          description: "Try to make an outbound HTTP request",
          async execute() {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 3000);
              const resp = await fetch("http://example.com", { signal: controller.signal });
              clearTimeout(timer);
              return "connected";
            } catch (err) {
              return "error:" + err.message;
            }
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

  test("tmpfs write is limited to configured size", async () => {
    const tmpfsBundle = `
    export default {
      name: "tmpfs-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 1,
      tools: {
        fill_tmp: {
          description: "Write data to /tmp until ENOSPC",
          async execute() {
            try {
              const data = new Uint8Array(20 * 1024 * 1024);
              await Deno.writeFile("/tmp/bigfile", data);
              return "wrote:20MB";
            } catch (err) {
              return "error:" + err.message;
            }
          },
        },
      },
    };
    `;

    const { sandbox, conn } = await spawnSandbox("tmpfs-test");

    try {
      await conn.sendRequest("bundle/load", { code: tmpfsBundle, env: {} });
      const resp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "fill_tmp",
        args: {},
        sessionId: "s1",
        messages: [],
      });

      expect(resp.result).toMatch(/^error:/);
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("no environment variables leak to guest", async () => {
    const envBundle = `
    export default {
      name: "env-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 1,
      tools: {
        check_env: {
          description: "Check environment",
          execute() {
            try {
              const env = Deno.env.toObject();
              return "env:" + JSON.stringify(env);
            } catch (err) {
              return "error:" + err.message;
            }
          },
        },
      },
    };
    `;

    const { sandbox, conn } = await spawnSandbox("env-test");

    try {
      await conn.sendRequest("bundle/load", { code: envBundle, env: {} });
      const resp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "check_env",
        args: {},
        sessionId: "s1",
        messages: [],
      });

      // Either Deno.env throws (no --allow-env) or returns minimal env
      if (resp.result.startsWith("error:")) {
        expect(resp.result).toMatch(/error:/);
      } else {
        const env = JSON.parse(resp.result.replace("env:", ""));
        expect(env).not.toHaveProperty("NODE_ENV");
      }
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);

  test("cannot write to root filesystem", async () => {
    const writeBundle = `
    export default {
      name: "write-agent",
      systemPrompt: "Test",
      greeting: "",
      maxSteps: 1,
      tools: {
        write_root: {
          description: "Try to write to /etc",
          execute() {
            try {
              Deno.writeTextFileSync("/etc/evil", "pwned");
              return "wrote";
            } catch (err) {
              return "error:" + err.message;
            }
          },
        },
      },
    };
    `;

    const { sandbox, conn } = await spawnSandbox("write-test");

    try {
      await conn.sendRequest("bundle/load", { code: writeBundle, env: {} });
      const resp = await conn.sendRequest<{ result: string }>("tool/execute", {
        name: "write_root",
        args: {},
        sessionId: "s1",
        messages: [],
      });

      expect(resp.result).toMatch(/^error:/);
    } finally {
      conn.dispose();
      await sandbox.cleanup();
      activeSandboxes.splice(activeSandboxes.indexOf(sandbox), 1);
    }
  }, 30_000);
});
