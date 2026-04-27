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

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
  const p = "/usr/local/bin/runsc";
  runscPath = existsSync(p) ? p : null;
  return runscPath;
}

/** Cached absolute path to deno binary, or null if not found. */
let denoPath: string | null | undefined;

function findDeno(): string | null {
  if (denoPath !== undefined) return denoPath;
  const p = "/usr/local/bin/deno";
  denoPath = existsSync(p) ? p : null;
  return denoPath;
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

const HOST_LIB_DIRS = ["/lib", "/lib64", "/usr/lib"] as const;

type LibBindMount = { destination: string; type: "bind"; source: string; options: string[] };

type RootfsState = {
  rootfsPath: string;
  libMounts: LibBindMount[];
};

/**
 * Cached promise of the prepared rootfs. Done once per process — the deno
 * binary, harness script, and lib bind-mount points are all stable across
 * sandbox spawns. Re-copying ~125 MB of deno binary on every spawn was
 * blocking the Node event loop on the request path; this hoists that work
 * out so it happens at most once.
 */
let rootfsReady: Promise<RootfsState> | null = null;

/**
 * Prepare the shared sandbox rootfs (deno binary, harness, lib mount points).
 *
 * Idempotent: calling more than once returns the same in-flight or completed
 * promise. Safe to invoke at server startup to pay the I/O cost off the hot
 * path; subsequent `createGvisorSandbox` calls reuse the cached state.
 */
export function prepareRootfs(harnessPath: string): Promise<RootfsState> {
  if (rootfsReady !== null) return rootfsReady;
  rootfsReady = (async () => {
    const denoSrc = findDeno();
    if (!denoSrc) throw new Error("deno not found on PATH");

    const t0 = performance.now();
    await mkdir(SANDBOX_ROOTFS, { recursive: true });
    const denoDest = join(SANDBOX_ROOTFS, "deno");
    await copyFile(denoSrc, denoDest);
    await chmod(denoDest, 0o755);
    await copyFile(harnessPath, join(SANDBOX_ROOTFS, "harness.mjs"));

    // Deno is dynamically linked — it needs the host's libc and dynamic
    // linker at runtime. Pre-create the bind-mount points once (idempotent
    // mkdir) so per-spawn we only have to point the OCI spec at them.
    const libMounts: LibBindMount[] = [];
    for (const dir of HOST_LIB_DIRS) {
      if (!existsSync(dir)) continue;
      await mkdir(join(SANDBOX_ROOTFS, dir), { recursive: true });
      libMounts.push({ destination: dir, type: "bind", source: dir, options: ["ro"] });
    }
    const ms = Math.round(performance.now() - t0);
    console.info("Sandbox rootfs prepared", { rootfs: SANDBOX_ROOTFS, ms });
    return { rootfsPath: SANDBOX_ROOTFS, libMounts };
  })().catch((err) => {
    rootfsReady = null;
    throw err;
  });
  return rootfsReady;
}

/** Create the bundle directory containing config.json for `runsc run`. */
async function prepareBundleDir(containerId: string, configJson: string): Promise<string> {
  const dir = join(BUNDLE_BASE, containerId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), configJson, "utf-8");
  return dir;
}

/** Remove the bundle directory for a container. Silently ignores errors. */
async function cleanupBundleDir(containerId: string): Promise<void> {
  try {
    await rm(join(BUNDLE_BASE, containerId), { recursive: true, force: true });
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
export async function createGvisorSandbox(opts: GvisorSandboxOptions): Promise<GvisorSandbox> {
  const runscBin = findRunsc();
  if (!runscBin) throw new Error("runsc not found on PATH");
  // Capture as const for closure narrowing across async boundaries.
  const runsc: string = runscBin;

  const t0 = performance.now();
  const { rootfsPath, libMounts } = await prepareRootfs(opts.harnessPath);
  const tRootfs = performance.now();

  const containerId = `aai-${opts.slug}-${nanoid(8)}`;

  const spec = buildOciSpec({
    rootfsPath,
    denoPath: "/deno",
    harnessPath: "/harness.mjs",
    ...(opts.limits && { limits: opts.limits }),
  });
  spec.mounts.push(...libMounts);

  const bundleDir = await prepareBundleDir(containerId, JSON.stringify(spec));
  const tBundle = performance.now();

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
  const tSpawn = performance.now();

  console.info("gVisor sandbox spawn timing", {
    slug: opts.slug,
    rootfsMs: Math.round(tRootfs - t0),
    bundleDirMs: Math.round(tBundle - tRootfs),
    spawnMs: Math.round(tSpawn - tBundle),
    totalMs: Math.round(tSpawn - t0),
  });

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
    await cleanupBundleDir(containerId);
  }
  return {
    process: child,
    containerId,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Test-only internals
// ---------------------------------------------------------------------------

/** @internal Reset the cached rootfs promise — exposed for tests only. */
export function _resetRootfsCacheForTest(): void {
  rootfsReady = null;
}
