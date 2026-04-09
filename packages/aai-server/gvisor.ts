// Copyright 2025 the AAI authors. MIT license.
/**
 * gVisor OCI sandbox for running agent code in a minimal container.
 *
 * Creates a gVisor (runsc) sandbox with a minimal rootfs containing only
 * the Node.js binary and the harness script. Communication with the
 * sandboxed process uses stdio pipes (stdin/stdout).
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VM_MEMORY_MIB } from "./constants.ts";

/**
 * Returns true if gVisor's `runsc` runtime is available on this system.
 * Always returns false on non-Linux platforms since gVisor only supports Linux.
 */
export function isGvisorAvailable(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("which", ["runsc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export type GvisorSandbox = {
  process: ChildProcess;
  cleanup(): Promise<void>;
};

/**
 * Creates a gVisor OCI sandbox with a minimal rootfs.
 * Only the node binary and harness script are accessible to the sandboxed process.
 */
export function createGvisorSandbox(opts: {
  slug: string;
  harnessPath: string;
  memoryLimitBytes?: number;
  pidsLimit?: number;
}): GvisorSandbox {
  const bundleDir = mkdtempSync(join(tmpdir(), `aai-gvisor-${opts.slug}-`));
  const rootfsDir = join(bundleDir, "rootfs");

  // Create minimal rootfs with only node + harness
  mkdirSync(join(rootfsDir, "app"), { recursive: true });
  mkdirSync(join(rootfsDir, "tmp"), { recursive: true });
  cpSync(process.execPath, join(rootfsDir, "node"));
  cpSync(opts.harnessPath, join(rootfsDir, "app", "harness.mjs"));

  // OCI runtime spec
  const config = {
    ociVersion: "1.0.0",
    process: {
      args: ["/node", "/app/harness.mjs"],
      cwd: "/",
      env: ["PATH=/"],
    },
    root: { path: "rootfs", readonly: true },
    mounts: [
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "nodev", "size=16m"],
      },
    ],
    linux: {
      namespaces: [{ type: "pid" }, { type: "ipc" }, { type: "mount" }, { type: "network" }],
      resources: {
        memory: {
          limit: opts.memoryLimitBytes ?? VM_MEMORY_MIB * 1024 * 1024,
        },
        pids: { limit: opts.pidsLimit ?? 32 },
      },
    },
  };

  writeFileSync(join(bundleDir, "config.json"), JSON.stringify(config));

  const containerId = `aai-${opts.slug}-${Date.now()}`;
  const child = spawn(
    "runsc",
    [
      "--rootless",
      "--platform=systrap",
      "--network=none",
      "run",
      "--bundle",
      bundleDir,
      containerId,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  return {
    process: child,
    async cleanup() {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.on("exit", () => resolve());
      });
      try {
        execFileSync("runsc", ["delete", "--force", containerId], {
          stdio: "ignore",
        });
      } catch {
        // Container may already be cleaned up
      }
      rmSync(bundleDir, { recursive: true, force: true });
    },
  };
}
