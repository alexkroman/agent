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
/** Cached absolute path to runsc binary, or null if not found. */
let runscPath: string | null | undefined;

function findRunsc(): string | null {
  if (runscPath !== undefined) return runscPath;
  if (process.platform !== "linux") {
    runscPath = null;
    return null;
  }
  try {
    runscPath = execFileSync("which", ["runsc"], { encoding: "utf-8" }).trim();
    return runscPath;
  } catch {
    runscPath = null;
    return null;
  }
}

export function isGvisorAvailable(): boolean {
  return findRunsc() !== null;
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
 * - Filesystem: only /node and /harness.mjs mounted (no host FS access)
 * - Env vars: empty (secrets delivered over jsonrpc)
 * - UID/GID: runs as nobody (65534)
 * - Agent code: injected over stdio, not from disk
 *
 * Resource limits (memory, PIDs) should be enforced by the container
 * orchestrator (Docker, Fly.io) since --ignore-cgroups is used for
 * compatibility with cgroup v1/v2 hybrid environments.
 */
export function createGvisorSandbox(opts: { slug: string; harnessPath: string }): GvisorSandbox {
  const runsc = findRunsc();
  if (!runsc) throw new Error("runsc not found on PATH");

  const child = spawn(
    runsc,
    [
      "--rootless",
      "--network=none",
      "--ignore-cgroups",
      "do",
      "-quiet",
      "-cwd",
      "/",
      // Mount only the node binary and harness — not the entire host FS
      "-force-overlay=false",
      "-volume",
      `${process.execPath}:/node:ro`,
      "-volume",
      `${opts.harnessPath}:/harness.mjs:ro`,
      // Run as nobody (uid/gid 65534)
      "-uid-map",
      "65534:65534:1",
      "-gid-map",
      "65534:65534:1",
      "--",
      "/node",
      "/harness.mjs",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Empty env: agent gets env vars over jsonrpc (bundle message),
      // not from host process.env. Prevents platform secrets from
      // leaking into the sandbox even via V8 exploits.
      env: {},
    },
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
