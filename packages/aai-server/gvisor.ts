// Copyright 2025 the AAI authors. MIT license.
/**
 * gVisor sandbox for running agent code with filesystem isolation.
 *
 * Uses `runsc do --rootfs` to run Node.js inside a gVisor sandbox with
 * a minimal rootfs containing only the node binary and harness script.
 * Communication uses stdio pipes (stdin/stdout).
 *
 * `runsc do` is simpler than `runsc run` (OCI mode) and works inside
 * Docker containers without special capabilities.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Creates a gVisor sandbox with a minimal rootfs.
 * Only the node binary and harness script are accessible.
 */
export function createGvisorSandbox(opts: { slug: string; harnessPath: string }): GvisorSandbox {
  const rootfsDir = mkdtempSync(join(tmpdir(), `aai-gvisor-${opts.slug}-`));

  // Create minimal rootfs with only node + harness
  mkdirSync(join(rootfsDir, "app"), { recursive: true });
  cpSync(process.execPath, join(rootfsDir, "node"));
  cpSync(opts.harnessPath, join(rootfsDir, "app", "harness.mjs"));

  const child = spawn(
    "runsc",
    [
      "--rootless",
      "--network=none",
      "do",
      "--rootfs",
      rootfsDir,
      "--",
      "/node",
      "/app/harness.mjs",
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
      rmSync(rootfsDir, { recursive: true, force: true });
    },
  };
}
