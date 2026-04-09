// Copyright 2025 the AAI authors. MIT license.
/**
 * gVisor sandbox for running agent code in isolation.
 *
 * Uses `runsc do` to run Node.js inside a gVisor sandbox. The host
 * filesystem is mounted read-only with a tmpfs overlay (writes go to
 * memory, not disk). Network is disabled (--network=none).
 *
 * Agent code is injected over stdio (not from disk), so even though
 * the host FS is readable, the agent has no network to exfiltrate data.
 *
 * Communication uses stdio pipes (stdin/stdout) with vscode-jsonrpc.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";

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
 * Creates a gVisor sandbox running the given Node.js harness script.
 *
 * Security layers:
 * - Syscall interception: gVisor Sentry reimplements syscalls in Go
 * - Network: disabled (--network=none)
 * - Filesystem: host FS is read-only with tmpfs overlay
 * - Agent code: injected over stdio, not from disk
 *
 * Resource limits (memory, PIDs) should be enforced by the container
 * orchestrator (Docker, Fly.io) since --ignore-cgroups is used for
 * compatibility with cgroup v1/v2 hybrid environments.
 */
export function createGvisorSandbox(opts: { slug: string; harnessPath: string }): GvisorSandbox {
  const child = spawn(
    "runsc",
    [
      "--rootless",
      "--network=none",
      "--ignore-cgroups",
      "do",
      "-quiet",
      "--",
      process.execPath,
      opts.harnessPath,
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
    },
  };
}
