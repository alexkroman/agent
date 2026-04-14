// Copyright 2025 the AAI authors. MIT license.
/**
 * gVisor sandbox for running agent code in isolation.
 *
 * Uses `runsc run` with a full OCI runtime spec (config.json) to run
 * Deno inside a gVisor sandbox. This gives explicit control over every
 * security layer: capabilities, seccomp, namespaces, rlimits, mounts.
 *
 * Communication uses stdio pipes (stdin/stdout) with NDJSON transport.
 */

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { buildOciSpec, type SandboxResourceLimits } from "./oci-spec.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Binary discovery (cached)
// ---------------------------------------------------------------------------

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

/**
 * Returns true if gVisor's `runsc` runtime is available on this system.
 * Always returns false on non-Linux platforms since gVisor only supports Linux.
 */
export function isGvisorAvailable(): boolean {
  return findRunsc() !== null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GvisorSandbox = {
  process: ChildProcess;
  containerId: string;
  cleanup(): Promise<void>;
};

export type GvisorSandboxOptions = {
  slug: string;
  harnessPath: string;
  limits?: SandboxResourceLimits;
};

// ---------------------------------------------------------------------------
// Bundle directory management
// ---------------------------------------------------------------------------

const BUNDLE_BASE = "/tmp/aai-bundles";

const SANDBOX_ROOTFS = "/tmp/aai-sandbox-rootfs";

/**
 * Build a minimal rootfs containing only the Deno binary and harness script.
 * Copies are idempotent — `copyFileSync` overwrites if the file already exists.
 * The rootfs is shared across all sandboxes (mounted read-only in the OCI spec).
 */
function prepareSandboxRootfs(denoPath: string, harnessPath: string): string {
  mkdirSync(SANDBOX_ROOTFS, { recursive: true });
  copyFileSync(denoPath, join(SANDBOX_ROOTFS, "deno"));
  copyFileSync(harnessPath, join(SANDBOX_ROOTFS, "harness.mjs"));
  return SANDBOX_ROOTFS;
}

/** Create the bundle directory containing config.json for `runsc run`. */
function prepareBundleDir(containerId: string, configJson: string): string {
  const dir = join(BUNDLE_BASE, containerId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), configJson, "utf-8");
  return dir;
}

/** Remove the bundle directory for a container. Silently ignores errors. */
function cleanupBundleDir(containerId: string): void {
  try {
    rmSync(join(BUNDLE_BASE, containerId), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — directory may already be gone
  }
}

// ---------------------------------------------------------------------------
// Sandbox creation
// ---------------------------------------------------------------------------

/**
 * Creates a gVisor sandbox running the given Deno harness script.
 *
 * Security layers:
 * - Full OCI runtime spec with explicit seccomp, capabilities, namespaces
 * - Syscall interception: gVisor Sentry reimplements syscalls in Go
 * - Network: disabled (--network=none)
 * - Filesystem: readonly root with minimal tmpfs /tmp
 * - Env vars: controlled by OCI spec (PATH, HOME, NO_COLOR only)
 * - All capabilities dropped, noNewPrivileges enforced
 * - rlimits capping memory, PIDs, CPU time, open files
 * - Process runs as nobody (65534:65534)
 */
export function createGvisorSandbox(opts: GvisorSandboxOptions): GvisorSandbox {
  const runscBin = findRunsc();
  if (!runscBin) throw new Error("runsc not found on PATH");
  const denoBin = findDeno();
  if (!denoBin) throw new Error("deno not found on PATH");

  // Capture as const for closure (TS can't narrow module-level let across async closures)
  const runsc: string = runscBin;
  const deno: string = denoBin;

  const containerId = `aai-${opts.slug}-${nanoid(8)}`;

  const rootfs = prepareSandboxRootfs(deno, opts.harnessPath);

  const spec = buildOciSpec({
    rootfsPath: rootfs,
    denoPath: "/deno",
    harnessPath: "/harness.mjs",
    ...(opts.limits && { limits: opts.limits }),
  });

  const bundleDir = prepareBundleDir(containerId, JSON.stringify(spec));

  const child = spawn(
    runsc,
    ["--rootless", "--network=none", "--ignore-cgroups", "run", "--bundle", bundleDir, containerId],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Empty env: agent gets env vars from the OCI spec (PATH, HOME,
      // NO_COLOR only). Platform secrets never leak to the sandbox.
      env: {},
    },
  );

  let cleaned = false;

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    // 1. Try graceful shutdown via runsc kill
    try {
      await execFileAsync(runsc, ["kill", containerId, "SIGTERM"]);
    } catch {
      // Container may already be gone — ignore
    }

    // 2. Wait for process to exit (up to 5s), then SIGKILL
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) {
          resolve(true);
          return;
        }
        child.on("exit", () => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);

    if (!exited) {
      try {
        await execFileAsync(runsc, ["kill", containerId, "SIGKILL"]);
      } catch {
        // Ignore — best effort
      }
      // Wait briefly for SIGKILL to take effect
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.on("exit", () => resolve());
        setTimeout(() => resolve(), 2000);
      });
    }

    // 3. Force-delete the container
    try {
      await execFileAsync(runsc, ["delete", "--force", containerId]);
    } catch {
      // Ignore — container may already be cleaned up
    }

    // 4. Remove bundle directory
    cleanupBundleDir(containerId);
  }
  return {
    process: child,
    containerId,
    cleanup,
  };
}
