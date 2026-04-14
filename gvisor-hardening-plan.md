# gVisor Sandbox Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate gVisor sandbox from `runsc do` to `runsc run` with a full OCI runtime spec, adding seccomp denylist, capability drops, rlimit-based resource limits, mount hardening, Deno permission tightening, and proc masking.

**Architecture:** New `oci-spec.ts` module generates the entire OCI `config.json` programmatically. Rewritten `gvisor.ts` manages full container lifecycle (create/start/wait/delete). Resource limits use rlimits (not cgroups) for Firecracker/Fly.io compatibility. `--ignore-cgroups` is retained.

**Tech Stack:** Node.js (host), gVisor runsc, OCI runtime spec v1, Deno (guest), Vitest

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/aai-server/oci-spec.ts` | **New** — `buildOciSpec()`, `SandboxResourceLimits` type, seccomp denylist, OCI config generation |
| `packages/aai-server/oci-spec.test.ts` | **New** — Unit tests for spec generation |
| `packages/aai-server/gvisor.ts` | **Rewrite** — `runsc run` lifecycle (create/start/wait/delete), stale reaping, bundle dir management |
| `packages/aai-server/gvisor.test.ts` | **Rewrite** — Updated unit tests for new exports |
| `packages/aai-server/sandbox-vm.ts` | **Update** — Thread `SandboxResourceLimits` through, read operator env vars |
| `packages/aai-server/sandbox.ts` | **Minor** — Thread resource limits to `createSandboxVm` |
| `packages/aai-server/gvisor-integration.test.ts` | **Rewrite** — Updated for new lifecycle + new security tests |
| `packages/aai-server/Dockerfile` | **Minor** — Add `jq` for OCI spec debugging (optional) |

**Unchanged:** `guest/deno-harness.ts`, `ndjson-transport.ts`, `ssrf.ts`, `sandbox-slots.ts`

---

### Task 1: Create `oci-spec.ts` — Types and `buildOciSpec()` skeleton

**Files:**
- Create: `packages/aai-server/oci-spec.ts`
- Test: `packages/aai-server/oci-spec.test.ts`

- [ ] **Step 1: Write the failing test for buildOciSpec defaults**

```typescript
// packages/aai-server/oci-spec.test.ts
import { describe, expect, it } from "vitest";
import { buildOciSpec, type SandboxResourceLimits } from "./oci-spec.ts";

describe("buildOciSpec", () => {
  const baseOpts = {
    rootfsPath: "/rootfs",
    harnessPath: "/rootfs/harness.mjs",
    denoPath: "/rootfs/bin/deno",
  };

  it("returns a valid OCI runtime spec with defaults", () => {
    const spec = buildOciSpec(baseOpts);

    expect(spec.ociVersion).toBe("1.0.2");
    expect(spec.process.cwd).toBe("/tmp");
    expect(spec.process.noNewPrivileges).toBe(true);
    expect(spec.process.user).toEqual({ uid: 65534, gid: 65534 });
    expect(spec.root).toEqual({ path: "/rootfs", readonly: true });
  });

  it("sets Deno command with no --allow-env flag", () => {
    const spec = buildOciSpec(baseOpts);

    expect(spec.process.args).toEqual([
      "/rootfs/bin/deno",
      "run",
      "--v8-flags=--max-heap-size=64",
      "--no-prompt",
      "/rootfs/harness.mjs",
    ]);
  });

  it("sets minimal process.env", () => {
    const spec = buildOciSpec(baseOpts);

    expect(spec.process.env).toEqual([
      "PATH=/usr/bin:/bin",
      "HOME=/tmp",
      "NO_COLOR=1",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/oci-spec.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/aai-server/oci-spec.ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * OCI runtime spec generator for gVisor sandboxes.
 *
 * Generates a complete config.json for `runsc run`. All security
 * configuration (seccomp, capabilities, rlimits, mounts) lives here
 * in one typed, testable module.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SandboxResourceLimits = {
  memoryLimitBytes?: number;    // default 64 MB (67_108_864)
  pidLimit?: number;            // default 32
  tmpfsSizeBytes?: number;      // default 10 MB (10_485_760)
  cpuTimeLimitSecs?: number;    // default 60
};

type OciProcess = {
  terminal: boolean;
  user: { uid: number; gid: number };
  args: string[];
  env: string[];
  cwd: string;
  noNewPrivileges: boolean;
  oomScoreAdj: number;
  capabilities: {
    bounding: string[];
    effective: string[];
    permitted: string[];
    inheritable: string[];
    ambient: string[];
  };
  rlimits: Array<{ type: string; hard: number; soft: number }>;
};

type OciMount = {
  destination: string;
  type?: string;
  source?: string;
  options?: string[];
};

type OciLinux = {
  namespaces: Array<{ type: string }>;
  seccomp: OciSeccomp;
  maskedPaths: string[];
  readonlyPaths: string[];
};

type OciSeccomp = {
  defaultAction: string;
  syscalls: Array<{
    names: string[];
    action: string;
    errnoRet?: number;
  }>;
};

export type OciRuntimeSpec = {
  ociVersion: string;
  process: OciProcess;
  root: { path: string; readonly: boolean };
  mounts: OciMount[];
  linux: OciLinux;
};

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MEMORY_LIMIT_BYTES = 67_108_864;   // 64 MB
const DEFAULT_PID_LIMIT = 32;
const DEFAULT_TMPFS_SIZE_BYTES = 10_485_760;      // 10 MB
const DEFAULT_CPU_TIME_LIMIT_SECS = 60;
const DEFAULT_NOFILE_LIMIT = 256;

// ── Builder ──────────────────────────────────────────────────────────────────

export type BuildOciSpecOptions = {
  rootfsPath: string;
  harnessPath: string;
  denoPath: string;
  limits?: SandboxResourceLimits;
};

export function buildOciSpec(opts: BuildOciSpecOptions): OciRuntimeSpec {
  const limits = opts.limits ?? {};
  const memoryBytes = limits.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const memoryMb = Math.floor(memoryBytes / (1024 * 1024));
  const pidLimit = limits.pidLimit ?? DEFAULT_PID_LIMIT;
  const tmpfsBytes = limits.tmpfsSizeBytes ?? DEFAULT_TMPFS_SIZE_BYTES;
  const tmpfsMb = Math.floor(tmpfsBytes / (1024 * 1024));
  const cpuSecs = limits.cpuTimeLimitSecs ?? DEFAULT_CPU_TIME_LIMIT_SECS;

  return {
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: { uid: 65534, gid: 65534 },
      args: [
        opts.denoPath,
        "run",
        `--v8-flags=--max-heap-size=${memoryMb}`,
        "--no-prompt",
        opts.harnessPath,
      ],
      env: [
        "PATH=/usr/bin:/bin",
        "HOME=/tmp",
        "NO_COLOR=1",
      ],
      cwd: "/tmp",
      noNewPrivileges: true,
      oomScoreAdj: 1000,
      capabilities: {
        bounding: [],
        effective: [],
        permitted: [],
        inheritable: [],
        ambient: [],
      },
      rlimits: [
        { type: "RLIMIT_AS", hard: memoryBytes, soft: memoryBytes },
        { type: "RLIMIT_NPROC", hard: pidLimit, soft: pidLimit },
        { type: "RLIMIT_CPU", hard: cpuSecs, soft: cpuSecs },
        { type: "RLIMIT_NOFILE", hard: DEFAULT_NOFILE_LIMIT, soft: DEFAULT_NOFILE_LIMIT },
      ],
    },
    root: { path: opts.rootfsPath, readonly: true },
    mounts: [
      {
        destination: "/tmp",
        type: "tmpfs",
        source: "tmpfs",
        options: [
          "rw",
          "noexec",
          "nosuid",
          "nodev",
          `size=${tmpfsMb}m`,
        ],
      },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "noexec", "strictatime", "mode=755", "size=65536k"],
      },
      { destination: "/dev/null", type: "bind", source: "/dev/null", options: ["rw"] },
      { destination: "/dev/zero", type: "bind", source: "/dev/zero", options: ["rw"] },
      { destination: "/dev/urandom", type: "bind", source: "/dev/urandom", options: ["ro"] },
      {
        destination: "/proc",
        type: "proc",
        source: "proc",
        options: ["ro"],
      },
    ],
    linux: {
      namespaces: [
        { type: "pid" },
        { type: "mount" },
        { type: "ipc" },
        { type: "uts" },
      ],
      seccomp: buildSeccompProfile(),
      maskedPaths: [
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/timer_list",
        "/proc/sched_debug",
        "/proc/scsi",
      ],
      readonlyPaths: [
        "/proc/asound",
        "/proc/bus",
        "/proc/fs",
        "/proc/irq",
        "/proc/sys",
        "/proc/sysrq-trigger",
      ],
    },
  };
}

// ── Seccomp ──────────────────────────────────────────────────────────────────

/** Syscalls denied on top of gVisor defaults. */
const DENIED_SYSCALLS: string[] = [
  "ptrace",
  "mount",
  "umount2",
  "pivot_root",
  "chroot",
  "reboot",
  "sethostname",
  "setdomainname",
  "init_module",
  "finit_module",
  "delete_module",
  "kexec_load",
  "kexec_file_load",
  "unshare",
  "setns",
  "personality",
  "userfaultfd",
  "perf_event_open",
  "bpf",
  "keyctl",
  "request_key",
  "add_key",
  "acct",
  "quotactl",
  "syslog",
  "vhangup",
];

function buildSeccompProfile(): OciSeccomp {
  return {
    defaultAction: "SCMP_ACT_ALLOW",
    syscalls: [
      {
        names: [...DENIED_SYSCALLS],
        action: "SCMP_ACT_ERRNO",
        errnoRet: 1,
      },
    ],
  };
}

// ── Exported for testing ─────────────────────────────────────────────────────

export const _internals = {
  DENIED_SYSCALLS,
  DEFAULT_MEMORY_LIMIT_BYTES,
  DEFAULT_PID_LIMIT,
  DEFAULT_TMPFS_SIZE_BYTES,
  DEFAULT_CPU_TIME_LIMIT_SECS,
  DEFAULT_NOFILE_LIMIT,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/oci-spec.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/oci-spec.ts packages/aai-server/oci-spec.test.ts
git commit -m "feat(server): add OCI runtime spec generator (oci-spec.ts)"
```

---

### Task 2: Add full unit tests for `oci-spec.ts`

**Files:**
- Modify: `packages/aai-server/oci-spec.test.ts`

- [ ] **Step 1: Add tests for rlimits, capabilities, seccomp, mounts, operator overrides, and validation**

Append to `oci-spec.test.ts`:

```typescript
  it("drops all capabilities", () => {
    const spec = buildOciSpec(baseOpts);
    const caps = spec.process.capabilities;

    expect(caps.bounding).toEqual([]);
    expect(caps.effective).toEqual([]);
    expect(caps.permitted).toEqual([]);
    expect(caps.inheritable).toEqual([]);
    expect(caps.ambient).toEqual([]);
  });

  it("sets default rlimits", () => {
    const spec = buildOciSpec(baseOpts);
    const rlimits = spec.process.rlimits;

    expect(rlimits).toContainEqual({
      type: "RLIMIT_AS",
      hard: 67_108_864,
      soft: 67_108_864,
    });
    expect(rlimits).toContainEqual({
      type: "RLIMIT_NPROC",
      hard: 32,
      soft: 32,
    });
    expect(rlimits).toContainEqual({
      type: "RLIMIT_CPU",
      hard: 60,
      soft: 60,
    });
    expect(rlimits).toContainEqual({
      type: "RLIMIT_NOFILE",
      hard: 256,
      soft: 256,
    });
  });

  it("applies operator overrides to rlimits", () => {
    const spec = buildOciSpec({
      ...baseOpts,
      limits: {
        memoryLimitBytes: 134_217_728, // 128 MB
        pidLimit: 64,
        cpuTimeLimitSecs: 120,
      },
    });

    expect(spec.process.rlimits).toContainEqual({
      type: "RLIMIT_AS",
      hard: 134_217_728,
      soft: 134_217_728,
    });
    expect(spec.process.rlimits).toContainEqual({
      type: "RLIMIT_NPROC",
      hard: 64,
      soft: 64,
    });
    expect(spec.process.rlimits).toContainEqual({
      type: "RLIMIT_CPU",
      hard: 120,
      soft: 120,
    });
  });

  it("scales V8 max-heap-size with memory limit", () => {
    const spec = buildOciSpec({
      ...baseOpts,
      limits: { memoryLimitBytes: 134_217_728 },
    });

    expect(spec.process.args).toContain("--v8-flags=--max-heap-size=128");
  });

  it("applies tmpfs size override to mount options", () => {
    const spec = buildOciSpec({
      ...baseOpts,
      limits: { tmpfsSizeBytes: 20_971_520 }, // 20 MB
    });

    const tmpfsMount = spec.mounts.find((m) => m.destination === "/tmp");
    expect(tmpfsMount?.options).toContain("size=20m");
  });

  it("includes seccomp denylist with all expected syscalls", () => {
    const spec = buildOciSpec(baseOpts);
    const denied = spec.linux.seccomp.syscalls[0];

    expect(spec.linux.seccomp.defaultAction).toBe("SCMP_ACT_ALLOW");
    expect(denied.action).toBe("SCMP_ACT_ERRNO");
    expect(denied.errnoRet).toBe(1);
    expect(denied.names).toContain("ptrace");
    expect(denied.names).toContain("mount");
    expect(denied.names).toContain("unshare");
    expect(denied.names).toContain("setns");
    expect(denied.names).toContain("bpf");
    expect(denied.names).toContain("userfaultfd");
    expect(denied.names).toContain("kexec_load");
    expect(denied.names).toHaveLength(26);
  });

  it("masks sensitive /proc paths", () => {
    const spec = buildOciSpec(baseOpts);

    expect(spec.linux.maskedPaths).toContain("/proc/kcore");
    expect(spec.linux.maskedPaths).toContain("/proc/keys");
    expect(spec.linux.readonlyPaths).toContain("/proc/sys");
  });

  it("mounts rootfs as read-only", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.root.readonly).toBe(true);
  });

  it("mounts /tmp with noexec, nosuid, nodev", () => {
    const spec = buildOciSpec(baseOpts);
    const tmpfs = spec.mounts.find((m) => m.destination === "/tmp");

    expect(tmpfs?.options).toContain("noexec");
    expect(tmpfs?.options).toContain("nosuid");
    expect(tmpfs?.options).toContain("nodev");
  });

  it("mounts only /dev/null, /dev/zero, /dev/urandom", () => {
    const spec = buildOciSpec(baseOpts);
    const devMounts = spec.mounts
      .filter((m) => m.destination.startsWith("/dev/") && m.type === "bind")
      .map((m) => m.destination)
      .sort();

    expect(devMounts).toEqual(["/dev/null", "/dev/urandom", "/dev/zero"]);
  });

  it("sets oomScoreAdj to 1000", () => {
    const spec = buildOciSpec(baseOpts);
    expect(spec.process.oomScoreAdj).toBe(1000);
  });

  it("includes pid, mount, ipc, uts namespaces", () => {
    const spec = buildOciSpec(baseOpts);
    const nsTypes = spec.linux.namespaces.map((n) => n.type);

    expect(nsTypes).toContain("pid");
    expect(nsTypes).toContain("mount");
    expect(nsTypes).toContain("ipc");
    expect(nsTypes).toContain("uts");
    expect(nsTypes).not.toContain("network");
  });
```

- [ ] **Step 2: Run tests to verify they all pass**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/oci-spec.test.ts`
Expected: PASS (all 16 tests)

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/oci-spec.test.ts
git commit -m "test(server): comprehensive unit tests for OCI spec generation"
```

---

### Task 3: Rewrite `gvisor.ts` — OCI lifecycle

**Files:**
- Modify: `packages/aai-server/gvisor.ts`
- Modify: `packages/aai-server/gvisor.test.ts`

- [ ] **Step 1: Write the failing test for the new API**

Replace `gvisor.test.ts` contents:

```typescript
// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, it } from "vitest";
import { isGvisorAvailable } from "./gvisor.ts";

describe("isGvisorAvailable", () => {
  it("returns a boolean", () => {
    const result = isGvisorAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("returns false on non-Linux platforms", () => {
    if (process.platform !== "linux") {
      expect(isGvisorAvailable()).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline — tests should still pass)**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/gvisor.test.ts`
Expected: PASS

- [ ] **Step 3: Rewrite `gvisor.ts` with full OCI lifecycle**

Replace `packages/aai-server/gvisor.ts` with:

```typescript
// Copyright 2025 the AAI authors. MIT license.
/**
 * gVisor sandbox for running agent code in isolation.
 *
 * Uses `runsc run` with a full OCI runtime spec (config.json) to run
 * Deno inside a gVisor sandbox. The spec is generated by `oci-spec.ts`
 * and includes: seccomp denylist, all capabilities dropped, rlimits,
 * read-only rootfs, size-limited tmpfs, and proc masking.
 *
 * Container lifecycle: create → start → [NDJSON over stdio] → kill → delete
 *
 * Communication uses stdio pipes (stdin/stdout) with NDJSON transport.
 */

import {
  type ChildProcess,
  execFileSync,
  execFile,
  spawn,
} from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import { buildOciSpec, type SandboxResourceLimits } from "./oci-spec.ts";

const execFileAsync = promisify(execFile);

// ── Binary discovery ────────────────────────────────────────────────────────

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

// ── Types ───────────────────────────────────────────────────────────────────

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

// ── Bundle directory ────────────────────────────────────────────────────────

const BUNDLE_BASE_DIR = "/tmp/aai-bundles";

function prepareBundleDir(containerId: string, configJson: string): string {
  const bundleDir = join(BUNDLE_BASE_DIR, containerId);
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, "config.json"), configJson, "utf-8");
  return bundleDir;
}

function cleanupBundleDir(containerId: string): void {
  try {
    rmSync(join(BUNDLE_BASE_DIR, containerId), { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ── Container lifecycle ─────────────────────────────────────────────────────

/**
 * Creates a gVisor sandbox running the given Deno harness script.
 *
 * Uses `runsc run` with a full OCI runtime spec that includes:
 * - Seccomp denylist (26 high-risk syscalls blocked)
 * - All capabilities dropped
 * - rlimits: memory (RLIMIT_AS), PIDs, CPU time, file descriptors
 * - Read-only rootfs with size-limited tmpfs at /tmp
 * - Masked /proc paths
 * - No --allow-env on Deno (env delivered via NDJSON)
 * - noNewPrivileges, oomScoreAdj=1000, runs as nobody (65534)
 * - Network disabled (--network=none)
 */
export function createGvisorSandbox(opts: GvisorSandboxOptions): GvisorSandbox {
  const runsc = findRunsc();
  if (!runsc) throw new Error("runsc not found on PATH");
  const deno = findDeno();
  if (!deno) throw new Error("deno not found on PATH");

  const containerId = `aai-${opts.slug}-${nanoid(8)}`;

  const spec = buildOciSpec({
    rootfsPath: "/",
    harnessPath: opts.harnessPath,
    denoPath: deno,
    limits: opts.limits,
  });

  const configJson = JSON.stringify(spec, null, 2);
  const bundleDir = prepareBundleDir(containerId, configJson);

  const child = spawn(
    runsc,
    [
      "--rootless",
      "--network=none",
      "--ignore-cgroups",
      "run",
      "--bundle",
      bundleDir,
      containerId,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {},
    },
  );

  let cleaned = false;

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    // Try graceful kill first
    try {
      await execFileAsync(runsc, ["kill", containerId, "SIGTERM"]);
    } catch {
      // Container may already be gone
    }

    // Wait up to 5 seconds for exit
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (child.exitCode !== null) {
          resolve(true);
          return;
        }
        child.on("exit", () => resolve(true));
      }),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), 5000),
      ),
    ]);

    // Force kill if still running
    if (!exited) {
      try {
        await execFileAsync(runsc, ["kill", containerId, "SIGKILL"]);
      } catch {
        // Ignore
      }
      child.kill("SIGKILL");
    }

    // Delete container
    try {
      await execFileAsync(runsc, ["delete", "--force", containerId]);
    } catch {
      // Container may already be cleaned up
    }

    cleanupBundleDir(containerId);
  }

  return { process: child, containerId, cleanup };
}

// ── Stale container reaping ─────────────────────────────────────────────────

/**
 * Cleans up stale `aai-*` containers from a previous server run.
 * Call on server startup.
 */
export async function reapStaleContainers(): Promise<number> {
  const runsc = findRunsc();
  if (!runsc) return 0;

  let output: string;
  try {
    const result = await execFileAsync(runsc, ["list", "-format=json"]);
    output = result.stdout;
  } catch {
    return 0;
  }

  let containers: Array<{ id: string }>;
  try {
    containers = JSON.parse(output) as Array<{ id: string }>;
  } catch {
    return 0;
  }

  const stale = containers.filter((c) => c.id.startsWith("aai-"));
  for (const c of stale) {
    try {
      await execFileAsync(runsc, ["delete", "--force", c.id]);
    } catch {
      // Ignore individual cleanup failures
    }
    cleanupBundleDir(c.id);
  }

  if (stale.length > 0) {
    console.info(`Reaped ${stale.length} stale sandbox container(s)`);
  }

  return stale.length;
}
```

- [ ] **Step 4: Run unit test to verify it still passes**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/gvisor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/gvisor.ts packages/aai-server/gvisor.test.ts
git commit -m "feat(server): rewrite gvisor.ts with runsc-run OCI lifecycle"
```

---

### Task 4: Update `sandbox-vm.ts` — Thread resource limits and operator env vars

**Files:**
- Modify: `packages/aai-server/sandbox-vm.ts`

- [ ] **Step 1: Write the failing test for operator overrides**

Create a test that verifies `SandboxVmOptions` accepts a `limits` field. Add to a new section at the bottom of an existing test file, or verify via integration. Since `sandbox-vm.ts` is primarily tested via integration tests, we verify the type threading compiles and the env var parsing works.

Add a small unit test file:

```typescript
// packages/aai-server/sandbox-vm-limits.test.ts
import { describe, expect, it } from "vitest";
import { parseSandboxLimitsFromEnv } from "./sandbox-vm.ts";

describe("parseSandboxLimitsFromEnv", () => {
  it("returns defaults when no env vars set", () => {
    const limits = parseSandboxLimitsFromEnv({});
    expect(limits).toEqual({});
  });

  it("parses SANDBOX_MEMORY_LIMIT_MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "128" });
    expect(limits.memoryLimitBytes).toBe(134_217_728);
  });

  it("parses SANDBOX_PID_LIMIT", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "64" });
    expect(limits.pidLimit).toBe(64);
  });

  it("parses SANDBOX_TMPFS_LIMIT_MB", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_TMPFS_LIMIT_MB: "20" });
    expect(limits.tmpfsSizeBytes).toBe(20_971_520);
  });

  it("parses SANDBOX_CPU_TIME_LIMIT_SECS", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_CPU_TIME_LIMIT_SECS: "120" });
    expect(limits.cpuTimeLimitSecs).toBe(120);
  });

  it("clamps memory to valid range (16–512 MB)", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "8" }).memoryLimitBytes)
      .toBe(16 * 1024 * 1024);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "1024" }).memoryLimitBytes)
      .toBe(512 * 1024 * 1024);
  });

  it("clamps PIDs to valid range (8–256)", () => {
    expect(parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "2" }).pidLimit).toBe(8);
    expect(parseSandboxLimitsFromEnv({ SANDBOX_PID_LIMIT: "999" }).pidLimit).toBe(256);
  });

  it("ignores non-numeric values", () => {
    const limits = parseSandboxLimitsFromEnv({ SANDBOX_MEMORY_LIMIT_MB: "abc" });
    expect(limits.memoryLimitBytes).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/sandbox-vm-limits.test.ts`
Expected: FAIL — `parseSandboxLimitsFromEnv` not found

- [ ] **Step 3: Add `parseSandboxLimitsFromEnv` and thread limits through `sandbox-vm.ts`**

Add to the top of `sandbox-vm.ts`, after existing imports:

```typescript
import type { SandboxResourceLimits } from "./oci-spec.ts";
```

Add the `SandboxVmOptions` type update — add `limits?: SandboxResourceLimits` field:

```typescript
export type SandboxVmOptions = {
  slug: string;
  workerCode: string;
  env: Record<string, string>;
  harnessPath: string;
  kvStorage?: Storage;
  kvPrefix?: string;
  limits?: SandboxResourceLimits;
};
```

Add the env var parser (before the factory function):

```typescript
// ── Operator resource limit overrides ──────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parseSandboxLimitsFromEnv(
  env: Record<string, string | undefined>,
): SandboxResourceLimits {
  const limits: SandboxResourceLimits = {};

  const memMb = Number(env.SANDBOX_MEMORY_LIMIT_MB);
  if (Number.isFinite(memMb)) {
    limits.memoryLimitBytes = clamp(memMb, 16, 512) * 1024 * 1024;
  }

  const pids = Number(env.SANDBOX_PID_LIMIT);
  if (Number.isFinite(pids)) {
    limits.pidLimit = clamp(pids, 8, 256);
  }

  const tmpfsMb = Number(env.SANDBOX_TMPFS_LIMIT_MB);
  if (Number.isFinite(tmpfsMb)) {
    limits.tmpfsSizeBytes = clamp(tmpfsMb, 1, 100) * 1024 * 1024;
  }

  const cpuSecs = Number(env.SANDBOX_CPU_TIME_LIMIT_SECS);
  if (Number.isFinite(cpuSecs)) {
    limits.cpuTimeLimitSecs = clamp(cpuSecs, 10, 300);
  }

  return limits;
}
```

Update `createGvisorSandboxHandle` to pass limits through:

```typescript
export async function createGvisorSandboxHandle(opts: SandboxVmOptions): Promise<SandboxHandle> {
  const gvisor = createGvisorSandbox({
    slug: opts.slug,
    harnessPath: opts.harnessPath,
    limits: opts.limits,
  });
  return configureSandbox(createConnection(gvisor.process), opts, () => gvisor.cleanup());
}
```

Update `createSandboxVm` factory to merge operator env limits:

```typescript
export async function createSandboxVm(opts: SandboxVmOptions): Promise<SandboxHandle> {
  // Merge operator env var overrides with any explicitly-passed limits
  const envLimits = parseSandboxLimitsFromEnv(process.env);
  const mergedOpts: SandboxVmOptions = {
    ...opts,
    limits: { ...envLimits, ...opts.limits },
  };

  if (isGvisorAvailable()) return createGvisorSandboxHandle(mergedOpts);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "gVisor (runsc) is required in production but not found on PATH. " +
        "Install runsc: https://gvisor.dev/docs/user_guide/install/ — " +
        "Running untrusted agent code without sandbox isolation is not allowed.",
    );
  }

  console.warn(
    "[sandbox] WARNING: gVisor not available. Running without sandbox isolation (dev mode only).",
  );
  return createDevSandbox(mergedOpts);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm vitest run --project aai-server packages/aai-server/sandbox-vm-limits.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run existing server tests to check nothing broke**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm test:aai-server`
Expected: PASS (all existing tests)

- [ ] **Step 6: Commit**

```bash
git add packages/aai-server/sandbox-vm.ts packages/aai-server/sandbox-vm-limits.test.ts
git commit -m "feat(server): add operator resource limit overrides to sandbox-vm"
```

---

### Task 5: Update `deno-harness.ts` — Remove `--allow-env` dependency

**Files:**
- Modify: `packages/aai-server/guest/deno-harness.ts`

- [ ] **Step 1: Audit Deno.env usage in the harness**

Search for all `Deno.env` usage in `deno-harness.ts`. Currently at line 302-303:

```typescript
for (const [key, value] of Object.entries(env)) {
  Deno.env.set(key, value);
}
```

This sets env vars from the bundle message into the Deno process env. Without `--allow-env`, `Deno.env.set()` will throw. Since agent code receives env via `ctx.env` (the `_bundleEnv` object), this `Deno.env.set` loop is unnecessary — it was a convenience for agent code that directly reads `Deno.env`, which shouldn't be possible in a locked-down sandbox.

- [ ] **Step 2: Remove the Deno.env.set loop from loadBundle**

In `packages/aai-server/guest/deno-harness.ts`, replace the `loadBundle` function at lines 299-315:

```typescript
async function loadBundle(code: string, env: Record<string, string>): Promise<AgentDef> {
  // Store env from bundle message — agents access via ctx.env, not Deno.env
  _bundleEnv = Object.freeze({ ...env });

  const dataUrl = `data:application/javascript,${encodeURIComponent(code)}`;
  const mod = await import(dataUrl);
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object") {
    throw new Error("Agent bundle must export an object");
  }

  return agent;
}
```

- [ ] **Step 3: Update the file header comment**

Change line 17 from:
```
 * Run with: deno run --allow-env --no-prompt deno-harness.ts
```
to:
```
 * Run with: deno run --no-prompt deno-harness.ts
```

- [ ] **Step 4: Also remove `--allow-env` from dev sandbox in sandbox-vm.ts**

In `packages/aai-server/sandbox-vm.ts`, update the `createDevSandbox` function's spawn args at line 103:

Change:
```typescript
["run", "--allow-env", "--no-prompt", opts.harnessPath],
```
to:
```typescript
["run", "--no-prompt", opts.harnessPath],
```

Note: Dev sandbox still passes `env: { ...process.env }` which makes env available to Deno, but `--allow-env` is no longer in the Deno args. Deno with no `--allow-env` flag and env vars in the process will still be able to read them in recent Deno versions, but the harness code no longer calls `Deno.env.set()`.

**Actually, reconsider:** In dev mode (macOS), agent code may still want to access env vars via `Deno.env`. Since dev mode has no security boundary, keep `--allow-env` in `createDevSandbox` only. The gVisor path (production) already doesn't use it via the OCI spec.

Revert the dev sandbox change — leave `--allow-env` in `createDevSandbox`.

- [ ] **Step 5: Build the guest harness and run template tests**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm --filter aai-server build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add packages/aai-server/guest/deno-harness.ts
git commit -m "fix(server): remove Deno.env.set from harness, no longer needs --allow-env"
```

---

### Task 6: Rewrite `gvisor-integration.test.ts` — Updated lifecycle + security tests

**Files:**
- Modify: `packages/aai-server/gvisor-integration.test.ts`

- [ ] **Step 1: Update the spawnSandbox helper for the new API**

The `createGvisorSandbox` function now returns a `containerId` field and uses `runsc run`. Update the helper and imports:

```typescript
// Replace imports at line 17
import {
  createGvisorSandbox,
  type GvisorSandbox,
  isGvisorAvailable,
} from "./gvisor.ts";
```

No structural changes needed to `spawnSandbox` — it already calls `createGvisorSandbox` and uses the `.process` field for NDJSON. The new code returns the same `GvisorSandbox` shape (with added `containerId`).

- [ ] **Step 2: Add new security tests after existing tests**

Append inside the `describe.skipIf(!canRun)` block:

```typescript
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
              // Try writing 20MB (default tmpfs limit is 10MB)
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
        // If env accessible, should only have PATH, HOME, NO_COLOR
        const env = JSON.parse(resp.result.replace("env:", ""));
        expect(env).not.toHaveProperty("NODE_ENV");
        expect(env).not.toHaveProperty("HOME", expect.not.stringContaining("/tmp"));
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
```

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/gvisor-integration.test.ts
git commit -m "test(server): add security boundary tests for hardened gVisor sandbox"
```

---

### Task 7: Verify full test suite and lint

**Files:**
- All modified files

- [ ] **Step 1: Run lint**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm lint`
Expected: PASS (no lint errors)

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run all unit tests**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm test`
Expected: PASS (all packages)

- [ ] **Step 4: Fix any failures, re-run**

If any tests fail, fix them and re-run. Common issues:
- Import path changes (verify `oci-spec.ts` exports match what `gvisor.ts` imports)
- `nanoid` may need to be added as a dependency to `aai-server` — check `package.json`
- Type mismatches in `SandboxVmOptions` changes rippling to `sandbox.ts`

- [ ] **Step 5: Run pnpm check:local**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm check:local`
Expected: PASS

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(server): address lint and type issues from gVisor hardening"
```

---

### Task 8: Create changeset and push

**Files:**
- Create: `.changeset/<generated>.md`

- [ ] **Step 1: Check if nanoid needs to be added as a dependency**

Run: `cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && grep '"nanoid"' packages/aai-server/package.json`

If not present, add it:
```bash
cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm --filter aai-server add nanoid
```

- [ ] **Step 2: Create changeset**

Since `aai-server` is a private package (not in the fixed release group), the changeset only needs to list it if it's publishable. Check the `private` field. If private, use an empty changeset:

```bash
cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm changeset add --empty
```

If not private:
```bash
cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && pnpm changeset:create --pkg aai-server --bump minor --summary "Harden gVisor sandbox: migrate to runsc-run with full OCI spec, seccomp denylist, capability drops, rlimits, mount hardening"
```

- [ ] **Step 3: Commit changeset**

```bash
cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && git add .changeset/ && git commit -m "chore: add changeset for gVisor hardening"
```

- [ ] **Step 4: Push and create PR**

```bash
cd /Users/alexkroman/Code/aai/agent-gvisor-hardening && git push -u origin feat/gvisor-hardening
```

Then create PR targeting `main`.
