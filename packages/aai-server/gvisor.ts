// Copyright 2025 the AAI authors. MIT license.
/**
 * gVisor sandbox for running agent code in isolation.
 *
 * Uses `runsc do` to run Deno inside a gVisor sandbox. The host
 * filesystem is mounted read-only with a tmpfs overlay (writes go to
 * memory, not disk). Network is disabled (--network=none).
 *
 * Agent code is injected over stdio (not from disk), so even though
 * the host FS is readable, the agent has no network to exfiltrate data.
 *
 * Communication uses stdio pipes (stdin/stdout) with NDJSON transport.
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

/** Cached absolute path to deno binary, or null if not found. */
let denoPath: string | null | undefined;

function findDeno(): string | null {
  if (denoPath !== undefined) return denoPath;
  try {
    denoPath = execFileSync("which", ["deno"], { encoding: "utf-8" }).trim();
    return denoPath;
  } catch {
    denoPath = null;
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
 * Creates a gVisor sandbox running the given Deno harness script.
 *
 * Security layers:
 * - Syscall interception: gVisor Sentry reimplements syscalls in Go
 * - Network: disabled (--network=none)
 * - Filesystem: host FS mounted read-only with tmpfs overlay (writes go to memory)
 * - Env vars: empty (secrets delivered over NDJSON RPC, not process.env)
 * - Agent code: injected over stdio, not from disk
 * - CWD: /tmp (not host working directory)
 *
 * Resource limits (memory, PIDs) should be enforced by the container
 * orchestrator (Docker, Fly.io) since --ignore-cgroups is used for
 * compatibility with cgroup v1/v2 hybrid environments.
 */
export function createGvisorSandbox(opts: { slug: string; harnessPath: string }): GvisorSandbox {
  const runsc = findRunsc();
  if (!runsc) throw new Error("runsc not found on PATH");
  const deno = findDeno();
  if (!deno) throw new Error("deno not found on PATH");

  const child = spawn(
    runsc,
    [
      "--rootless",
      "--network=none",
      "--ignore-cgroups",
      "do",
      "-quiet",
      "-cwd",
      "/tmp",
      "--",
      deno,
      "run",
      "--allow-env",
      "--no-prompt",
      opts.harnessPath,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Empty env: agent gets env vars over NDJSON RPC (bundle message),
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
