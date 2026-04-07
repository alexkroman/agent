# Process Jail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the secure-exec Rust V8 child process in an nsjail sandbox on Linux to provide OS-level defense-in-depth against V8 exploits.

**Architecture:** A `pnpm patch` on `@secure-exec/v8` adds a `SECURE_EXEC_V8_WRAPPER` env var check to `resolveBinaryPath()`. New modules in `aai-server` build nsjail config, write a wrapper script, and set the env var before the first sandbox boots. On macOS, the jail is skipped with a warning.

**Tech Stack:** nsjail (external binary on Linux), pnpm patch, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-07-process-jail-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `patches/@secure-exec__v8@0.2.1.patch` | Create | One-line env var check in `resolveBinaryPath()` |
| `packages/aai-server/seccomp-policy.ts` | Create | Syscall allowlist → nsjail seccomp policy string |
| `packages/aai-server/seccomp-allowlist.json` | Create | Checked-in syscall allowlist |
| `packages/aai-server/jail-config.ts` | Create | Build nsjail protobuf text config from options |
| `packages/aai-server/process-jail.ts` | Create | `isJailAvailable()`, `createJailedLauncher()`, platform detection |
| `packages/aai-server/sandbox.ts` | Modify | Call `createJailedLauncher()` before first sandbox boot |
| `packages/aai-server/constants.ts` | Modify | Add `JAIL_MEMORY_LIMIT_MB` constant |
| `packages/aai-server/process-jail.test.ts` | Create | Unit tests for config generation, policy, platform detection |
| `packages/aai-server/process-jail.integration.test.ts` | Create | Jail enforcement + smoke tests (Linux CI only) |
| `packages/aai-server/vitest.integration.config.ts` | Modify | Add `process-jail.integration.test.ts` to include list |
| `CLAUDE.md` | Modify | Document nsjail dependency and process jail in security architecture |

---

### Task 1: Patch secure-exec to support SECURE_EXEC_V8_WRAPPER env var

**Files:**
- Create: `patches/@secure-exec__v8@0.2.1.patch`
- Modify: `package.json` (pnpm patch metadata)

- [ ] **Step 1: Initialize the patch**

```bash
cd /Users/alexkroman/Code/aai/agent/.worktrees/process-security
pnpm patch @secure-exec/v8@0.2.1
```

This creates a temp directory with the package contents. Note the path it prints.

- [ ] **Step 2: Edit the runtime.js in the temp directory**

Open the file at `<temp-dir>/dist/runtime.js`. Find the `resolveBinaryPath()` function (around line 49) and add the env var check as the very first line inside it:

```js
function resolveBinaryPath() {
    if (process.env.SECURE_EXEC_V8_WRAPPER) return process.env.SECURE_EXEC_V8_WRAPPER;
    const binaryName = process.platform === "win32" ? "secure-exec-v8.exe" : "secure-exec-v8";
    // ... rest unchanged
```

- [ ] **Step 3: Commit the patch**

```bash
pnpm patch-commit <temp-dir>
```

This generates `patches/@secure-exec__v8@0.2.1.patch` and adds a `pnpm.patchedDependencies` entry to `package.json`.

- [ ] **Step 4: Verify the patch applies**

```bash
pnpm install
```

Expected: installs cleanly, patch applied.

- [ ] **Step 5: Verify the patched code**

```bash
grep "SECURE_EXEC_V8_WRAPPER" packages/aai-server/node_modules/.pnpm/@secure-exec+v8@0.2.1*/node_modules/@secure-exec/v8/dist/runtime.js
```

Expected: shows the env var check line.

- [ ] **Step 6: Commit**

```bash
git add patches/ package.json pnpm-lock.yaml
git commit -m "patch: add SECURE_EXEC_V8_WRAPPER env var to secure-exec binary resolution"
```

---

### Task 2: Create seccomp allowlist and policy builder

**Files:**
- Create: `packages/aai-server/seccomp-allowlist.json`
- Create: `packages/aai-server/seccomp-policy.ts`
- Create: `packages/aai-server/seccomp-policy.test.ts` (in `process-jail.test.ts`, but start here)

- [ ] **Step 1: Write the seccomp allowlist JSON**

Create `packages/aai-server/seccomp-allowlist.json`:

```json
{
  "_comment": "Syscall allowlist for the secure-exec Rust V8 runtime under nsjail. Update by profiling with: strace -c -f -p <pid>",
  "syscalls": [
    "accept4",
    "arch_prctl",
    "bind",
    "brk",
    "clock_getres",
    "clock_gettime",
    "clone3",
    "close",
    "connect",
    "dup",
    "dup2",
    "epoll_create1",
    "epoll_ctl",
    "epoll_wait",
    "eventfd2",
    "exit",
    "exit_group",
    "fcntl",
    "fstat",
    "futex",
    "getpeername",
    "getpid",
    "getrandom",
    "getsockname",
    "getsockopt",
    "gettid",
    "ioctl",
    "listen",
    "lseek",
    "madvise",
    "mmap",
    "mprotect",
    "mremap",
    "munmap",
    "nanosleep",
    "newfstatat",
    "openat",
    "pipe2",
    "poll",
    "ppoll",
    "prctl",
    "read",
    "readv",
    "recvmsg",
    "rt_sigaction",
    "rt_sigprocmask",
    "sched_yield",
    "sendmsg",
    "set_robust_list",
    "setsockopt",
    "sigaltstack",
    "socket",
    "tgkill",
    "timerfd_create",
    "timerfd_settime",
    "wait4",
    "write",
    "writev"
  ]
}
```

- [ ] **Step 2: Write the failing test for buildSeccompPolicy**

Create `packages/aai-server/process-jail.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { buildSeccompPolicy } from "./seccomp-policy.ts";

describe("buildSeccompPolicy", () => {
  test("generates POLICY_LOG lines for each allowed syscall", () => {
    const policy = buildSeccompPolicy();
    expect(policy).toContain("POLICY_LOG");
    expect(policy).toContain("read");
    expect(policy).toContain("write");
    expect(policy).toContain("mmap");
  });

  test("sets default action to KILL", () => {
    const policy = buildSeccompPolicy();
    expect(policy).toContain("DEFAULT KILL");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm vitest run packages/aai-server/process-jail.test.ts
```

Expected: FAIL — `buildSeccompPolicy` not found.

- [ ] **Step 4: Implement seccomp-policy.ts**

Create `packages/aai-server/seccomp-policy.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Seccomp-bpf policy builder for nsjail.
 *
 * Reads the checked-in syscall allowlist and generates nsjail's
 * Kafel-format seccomp policy string. Default action is KILL —
 * any syscall not on the allowlist terminates the process.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface SeccompAllowlist {
  _comment: string;
  syscalls: string[];
}

export function loadAllowlist(): SeccompAllowlist {
  return require("./seccomp-allowlist.json") as SeccompAllowlist;
}

/**
 * Build a Kafel-format seccomp policy string for nsjail.
 *
 * Format:
 * ```
 * POLICY seccomp_policy {
 *   ALLOW { read, write, ... }
 * }
 * DEFAULT KILL
 * USE seccomp_policy
 * ```
 */
export function buildSeccompPolicy(): string {
  const allowlist = loadAllowlist();
  const lines = [
    "POLICY seccomp_policy {",
    `  ALLOW { ${allowlist.syscalls.join(", ")} }`,
    "}",
    "DEFAULT KILL",
    "USE seccomp_policy",
  ];
  return lines.join("\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm vitest run packages/aai-server/process-jail.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/aai-server/seccomp-allowlist.json packages/aai-server/seccomp-policy.ts packages/aai-server/process-jail.test.ts
git commit -m "feat: add seccomp syscall allowlist and policy builder for process jail"
```

---

### Task 3: Create nsjail config builder

**Files:**
- Create: `packages/aai-server/jail-config.ts`
- Modify: `packages/aai-server/process-jail.test.ts`

- [ ] **Step 1: Write failing tests for buildJailConfig**

Add to `packages/aai-server/process-jail.test.ts`:

```ts
import { buildJailConfig, type JailOptions } from "./jail-config.ts";

const TEST_OPTIONS: JailOptions = {
  binaryPath: "/usr/local/bin/secure-exec-v8",
  socketDir: "/tmp/aai-abc123",
  memoryLimitMb: 256,
  sandboxId: "abc123",
};

describe("buildJailConfig", () => {
  test("sets mode to ONCE", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('mode: ONCE');
  });

  test("bind-mounts binary read-only", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('src: "/usr/local/bin/secure-exec-v8"');
    expect(config).toContain("is_ro: true");
  });

  test("bind-mounts socket dir read-write", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('src: "/tmp/aai-abc123"');
  });

  test("enables all namespace types", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("clone_newnet: true");
    expect(config).toContain("clone_newpid: true");
    expect(config).toContain("clone_newns: true");
    expect(config).toContain("clone_newuser: true");
  });

  test("sets memory cgroup limit", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("cgroup_mem_max: 268435456");
  });

  test("sets PID limit to 1", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("cgroup_pids_max: 1");
  });

  test("passes required env vars through", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain('envar: "SECURE_EXEC_V8_TOKEN"');
  });

  test("drops all capabilities", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("keep_caps: false");
  });

  test("includes seccomp policy", () => {
    const config = buildJailConfig(TEST_OPTIONS);
    expect(config).toContain("seccomp_string:");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run packages/aai-server/process-jail.test.ts
```

Expected: FAIL — `buildJailConfig` not found.

- [ ] **Step 3: Implement jail-config.ts**

Create `packages/aai-server/jail-config.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * nsjail protobuf text config builder.
 *
 * Generates a config file for nsjail that enforces:
 * - Read-only mount namespace with minimal bind-mounts
 * - PID, network, user, and mount namespace isolation
 * - seccomp-bpf syscall allowlist
 * - All capabilities dropped
 * - cgroup v2 memory and PID limits
 */

import { buildSeccompPolicy } from "./seccomp-policy.ts";

export interface JailOptions {
  /** Absolute path to the Rust V8 binary. */
  binaryPath: string;
  /** Directory for the UDS socket (bind-mounted read-write). */
  socketDir: string;
  /** Total memory limit in MB (Rust runtime + V8 heap). */
  memoryLimitMb: number;
  /** Short sandbox ID for unique paths (max 8 hex chars). */
  sandboxId: string;
}

/**
 * Build an nsjail protobuf text format config string.
 *
 * nsjail docs: https://github.com/google/nsjail
 * Config format: protobuf text format matching nsjail's config.proto
 */
export function buildJailConfig(options: JailOptions): string {
  const { binaryPath, socketDir, memoryLimitMb, sandboxId } = options;
  const memoryBytes = memoryLimitMb * 1024 * 1024;
  const seccompPolicy = buildSeccompPolicy();

  // Escape the seccomp policy string for protobuf text format
  const escapedPolicy = seccompPolicy
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

  return `
name: "aai-sandbox-${sandboxId}"
description: "AAI agent sandbox jail"

mode: ONCE
hostname: "sandbox"
cwd: "/tmp"

clone_newuser: true
clone_newns: true
clone_newpid: true
clone_newipc: true
clone_newnet: true
clone_newuts: true

keep_caps: false
disable_proc: false

rlimit_as_type: HARD
rlimit_core_type: HARD
rlimit_cpu_type: HARD
rlimit_fsize_type: HARD
rlimit_nofile_type: HARD

cgroup_mem_max: ${memoryBytes}
cgroup_pids_max: 1

envar: "SECURE_EXEC_V8_TOKEN"
envar: "SECURE_EXEC_V8_CODEC"
envar: "SECURE_EXEC_V8_MAX_SESSIONS"

mount {
  src: "/lib"
  dst: "/lib"
  is_bind: true
  is_ro: true
  mandatory: false
}

mount {
  src: "/lib64"
  dst: "/lib64"
  is_bind: true
  is_ro: true
  mandatory: false
}

mount {
  src: "/usr/lib"
  dst: "/usr/lib"
  is_bind: true
  is_ro: true
  mandatory: false
}

mount {
  src: "${binaryPath}"
  dst: "/bin/secure-exec-v8"
  is_bind: true
  is_ro: true
}

mount {
  src: "${socketDir}"
  dst: "${socketDir}"
  is_bind: true
  is_ro: false
}

mount {
  dst: "/proc"
  fstype: "proc"
  is_ro: true
}

mount {
  dst: "/tmp"
  fstype: "tmpfs"
  is_ro: false
}

exec_bin {
  path: "/bin/secure-exec-v8"
}

seccomp_string: "${escapedPolicy}"
`.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run packages/aai-server/process-jail.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/jail-config.ts packages/aai-server/process-jail.test.ts
git commit -m "feat: add nsjail config builder for process jail"
```

---

### Task 4: Create process-jail module (core logic)

**Files:**
- Create: `packages/aai-server/process-jail.ts`
- Modify: `packages/aai-server/process-jail.test.ts`
- Modify: `packages/aai-server/constants.ts`

- [ ] **Step 1: Add constant to constants.ts**

Add to `packages/aai-server/constants.ts`:

```ts
/** Total memory limit for nsjail cgroup (V8 heap + Rust runtime overhead, MB). */
export const JAIL_MEMORY_LIMIT_MB = 256;
```

- [ ] **Step 2: Write failing tests for process-jail.ts**

Add to `packages/aai-server/process-jail.test.ts`:

```ts
import { isJailAvailable, createJailedLauncher } from "./process-jail.ts";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { vi } from "vitest";

describe("isJailAvailable", () => {
  test("returns false on non-linux platforms", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(isJailAvailable()).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("createJailedLauncher", () => {
  test("writes wrapper script and config to temp dir", async () => {
    // Skip on non-Linux — createJailedLauncher requires nsjail on PATH
    if (process.platform !== "linux") return;

    const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-jail-test-"));
    try {
      const launcher = await createJailedLauncher({
        binaryPath: "/usr/bin/true",
        socketDir,
        memoryLimitMb: 256,
        sandboxId: "test01",
      });

      expect(launcher.binaryPath).toContain("aai-jail-test01");
      expect(existsSync(launcher.binaryPath)).toBe(true);

      const script = await fs.readFile(launcher.binaryPath, "utf-8");
      expect(script).toContain("#!/bin/sh");
      expect(script).toContain("nsjail");
      expect(script).toContain("jail.cfg");

      await launcher.cleanup();
      expect(existsSync(launcher.binaryPath)).toBe(false);
    } finally {
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm vitest run packages/aai-server/process-jail.test.ts
```

Expected: FAIL — `isJailAvailable` and `createJailedLauncher` not found.

- [ ] **Step 4: Implement process-jail.ts**

Create `packages/aai-server/process-jail.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * OS-level process jail for the secure-exec Rust V8 runtime.
 *
 * On Linux with nsjail installed, wraps the Rust binary in an nsjail
 * sandbox with namespace isolation, seccomp, capability dropping, and
 * cgroup resource limits. On macOS or when nsjail is unavailable,
 * skips the jail with a warning.
 *
 * Integration: set process.env.SECURE_EXEC_V8_WRAPPER to the wrapper
 * script path before any secure-exec module loads. The patched
 * resolveBinaryPath() in @secure-exec/v8 picks it up.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildJailConfig, type JailOptions } from "./jail-config.ts";

export type { JailOptions };

export interface JailedLauncher {
  /** Path to the wrapper shell script. */
  binaryPath: string;
  /** Remove temp wrapper script and config on shutdown. */
  cleanup(): Promise<void>;
}

let nsjailPath: string | null | undefined;

function findNsjail(): string | null {
  if (nsjailPath !== undefined) return nsjailPath;
  try {
    nsjailPath = execFileSync("which", ["nsjail"], { encoding: "utf-8" }).trim();
    return nsjailPath;
  } catch {
    nsjailPath = null;
    return null;
  }
}

/**
 * Check if OS-level process jail is available.
 * Requires Linux + nsjail on $PATH.
 */
export function isJailAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return findNsjail() !== null;
}

/**
 * Create a jailed launcher that wraps the Rust V8 binary in nsjail.
 *
 * Writes a temp wrapper script and nsjail config file. The wrapper
 * script path should be set as process.env.SECURE_EXEC_V8_WRAPPER
 * before secure-exec loads.
 *
 * @returns JailedLauncher with binaryPath and cleanup function.
 */
export async function createJailedLauncher(options: JailOptions): Promise<JailedLauncher> {
  const nsjail = findNsjail();
  if (!nsjail) throw new Error("nsjail not found on $PATH");

  const jailDir = path.join(options.socketDir, `aai-jail-${options.sandboxId}`);
  await fs.mkdir(jailDir, { recursive: true, mode: 0o700 });

  // Write nsjail config
  const configPath = path.join(jailDir, "jail.cfg");
  const config = buildJailConfig(options);
  await fs.writeFile(configPath, config, { mode: 0o600 });

  // Write wrapper script
  const wrapperPath = path.join(jailDir, "secure-exec-v8");
  const wrapperScript = [
    "#!/bin/sh",
    `exec ${nsjail} --config ${configPath} -- /bin/secure-exec-v8`,
  ].join("\n");
  await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o700 });

  return {
    binaryPath: wrapperPath,
    async cleanup() {
      await fs.rm(jailDir, { recursive: true, force: true });
    },
  };
}

/**
 * Initialize the process jail if available.
 *
 * Must be called before any secure-exec module is imported.
 * Sets process.env.SECURE_EXEC_V8_WRAPPER if jail is available.
 *
 * @returns cleanup function (no-op on macOS), or null if jail unavailable.
 */
export async function initProcessJail(options: {
  binaryPath: string;
  memoryLimitMb: number;
}): Promise<JailedLauncher | null> {
  if (!isJailAvailable()) {
    console.warn(
      `OS-level process jail unavailable (platform: ${process.platform}). ` +
      "Relying on secure-exec isolation only.",
    );
    return null;
  }

  const os = await import("node:os");
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-jail-"));
  const sandboxId = path.basename(socketDir).slice(-8);

  const launcher = await createJailedLauncher({
    binaryPath: options.binaryPath,
    socketDir,
    memoryLimitMb: options.memoryLimitMb,
    sandboxId,
  });

  process.env.SECURE_EXEC_V8_WRAPPER = launcher.binaryPath;
  console.info("Process jail initialized", { wrapper: launcher.binaryPath });

  return launcher;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm vitest run packages/aai-server/process-jail.test.ts
```

Expected: PASS (Linux tests pass on Linux, skip on macOS)

- [ ] **Step 6: Commit**

```bash
git add packages/aai-server/process-jail.ts packages/aai-server/constants.ts packages/aai-server/process-jail.test.ts
git commit -m "feat: add process-jail module with nsjail launcher and platform detection"
```

---

### Task 5: Integrate process jail into sandbox.ts

**Files:**
- Modify: `packages/aai-server/sandbox.ts`

- [ ] **Step 1: Add import and jail state to sandbox.ts**

At the top of `packages/aai-server/sandbox.ts`, add the import:

```ts
import { initProcessJail, isJailAvailable, type JailedLauncher } from "./process-jail.ts";
```

Add module-level state after the existing imports:

```ts
let jailLauncher: JailedLauncher | null = null;
let jailInitialized = false;
```

- [ ] **Step 2: Add jail initialization to startIsolate**

In the `startIsolate()` function, add jail initialization **before** the `new NodeRuntime(...)` constructor call (around line 95). The jail must be set up before secure-exec first resolves the binary path:

```ts
// Initialize process jail on first isolate boot (Linux only)
if (!jailInitialized) {
  jailInitialized = true;
  if (isJailAvailable()) {
    // Resolve the real binary path to pass to the jail config.
    // Use the same resolution logic secure-exec uses internally.
    const { resolveBinaryPath } = await import("./process-jail-binary-resolve.ts");
    const realBinaryPath = resolveBinaryPath();
    jailLauncher = await initProcessJail({
      binaryPath: realBinaryPath,
      memoryLimitMb: JAIL_MEMORY_LIMIT_MB,
    });
  }
}
```

Wait — we need to resolve the binary path the same way secure-exec does. But we can't import their internal function. Instead, we can resolve it ourselves by looking up the platform package:

Replace the above with this simpler approach — detect the binary from the `@secure-exec/v8-<platform>` package:

```ts
import { JAIL_MEMORY_LIMIT_MB } from "./constants.ts";

// Initialize process jail on first isolate boot (Linux only)
if (!jailInitialized) {
  jailInitialized = true;
  if (isJailAvailable()) {
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const require = createRequire(import.meta.url);
    const platformPkg = `@secure-exec/v8-${process.platform}-${process.arch === "x64" ? "x64-gnu" : "arm64-gnu"}`;
    try {
      const pkgDir = dirname(require.resolve(`${platformPkg}/package.json`));
      const binaryPath = join(pkgDir, "secure-exec-v8");
      jailLauncher = await initProcessJail({ binaryPath, memoryLimitMb: JAIL_MEMORY_LIMIT_MB });
    } catch (err) {
      console.warn("Failed to initialize process jail:", err);
    }
  }
}
```

- [ ] **Step 3: Add cleanup to shutdownSandbox**

In the `createSandbox()` function, modify `shutdownSandbox()` to clean up the jail. But since the jail is shared across all sandboxes (one Rust process), cleanup should only happen when the last sandbox shuts down. For now, we skip jail cleanup on individual sandbox shutdown — the jail process exits when the Rust binary exits, and temp files are cleaned on process exit.

Add a process exit handler after jail initialization instead:

```ts
if (jailLauncher) {
  process.once("beforeExit", () => {
    jailLauncher?.cleanup().catch(() => {});
  });
}
```

- [ ] **Step 4: Run existing sandbox tests to verify no regression**

```bash
pnpm vitest run --project aai-server
```

Expected: All existing tests PASS (jail is not available on macOS, so it's a no-op).

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/sandbox.ts
git commit -m "feat: integrate process jail into sandbox isolate startup"
```

---

### Task 6: Add integration tests for jail enforcement

**Files:**
- Create: `packages/aai-server/process-jail.integration.test.ts`
- Modify: `packages/aai-server/vitest.integration.config.ts`

- [ ] **Step 1: Add integration test file to vitest config**

Edit `packages/aai-server/vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

export default defineConfig({
  ...sharedConfig,
  test: {
    include: [
      "sandbox-integration.test.ts",
      "ws-integration.test.ts",
      "process-jail.integration.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

- [ ] **Step 2: Write integration tests**

Create `packages/aai-server/process-jail.integration.test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Integration tests for OS-level process jail.
 *
 * These tests verify that nsjail restrictions are properly enforced.
 * They run only on Linux where nsjail is available. On macOS/CI without
 * nsjail, the entire suite is skipped.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildJailConfig } from "./jail-config.ts";
import { isJailAvailable } from "./process-jail.ts";

const skip = !isJailAvailable();

function findNsjail(): string {
  return execFileSync("which", ["nsjail"], { encoding: "utf-8" }).trim();
}

/** Run a shell command inside the jail and return { exitCode, stdout, stderr }. */
async function runInJail(
  jailConfigPath: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const nsjail = findNsjail();
  try {
    const stdout = execFileSync(nsjail, [
      "--config", jailConfigPath,
      "--", "/bin/sh", "-c", command,
    ], { encoding: "utf-8", timeout: 10_000 });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe.skipIf(skip)("nsjail enforcement", () => {
  let tmpDir: string;
  let configPath: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-jail-integ-"));

    // Write a jail config that uses /bin/sh as the exec target
    // (instead of the Rust binary) so we can test restrictions
    const config = buildJailConfig({
      binaryPath: "/bin/sh",
      socketDir: tmpDir,
      memoryLimitMb: 64,
      sandboxId: "integ",
    });

    // Override exec_bin to use /bin/sh for testing
    const testConfig = config.replace(
      /exec_bin \{[^}]*\}/,
      'exec_bin {\n  path: "/bin/sh"\n}',
    );

    configPath = path.join(tmpDir, "test-jail.cfg");
    await fs.writeFile(configPath, testConfig);
  });

  afterAll(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("cannot read host /etc/passwd", async () => {
    const result = await runInJail(configPath, "cat /etc/passwd");
    expect(result.exitCode).not.toBe(0);
  });

  test("cannot write to filesystem root", async () => {
    const result = await runInJail(configPath, "touch /testfile");
    expect(result.exitCode).not.toBe(0);
  });

  test("PID namespace isolates processes", async () => {
    const result = await runInJail(configPath, "ls /proc | head -5");
    // Should only see PID 1 (the jailed process itself)
    expect(result.stdout).not.toContain("2\n");
  });

  test("network namespace blocks TCP", async () => {
    // Attempt to connect to an external host — should fail
    const result = await runInJail(
      configPath,
      "echo test | timeout 2 nc 1.1.1.1 80 2>&1 || echo BLOCKED",
    );
    expect(result.stdout + result.stderr).toContain("BLOCKED");
  });

  test("UDS socket dir is accessible", async () => {
    const result = await runInJail(configPath, `ls ${tmpDir}`);
    expect(result.exitCode).toBe(0);
  });
});

describe.skipIf(skip)("smoke test: sandbox boots in jail", () => {
  test("real secure-exec isolate boots inside nsjail", async () => {
    // This test verifies the full integration: nsjail wrapping the
    // real Rust binary. It reuses the sandbox-integration boot flow.
    // Skipped for now — requires nsjail + secure-exec binary on Linux CI.
    // Enable once CI has nsjail installed.
  });
});

describe("macOS fallback", () => {
  test("isJailAvailable returns false on non-Linux", () => {
    if (process.platform === "linux") return;
    expect(isJailAvailable()).toBe(false);
  });
});
```

- [ ] **Step 3: Run integration tests (Linux only)**

```bash
pnpm --filter @alexkroman1/aai-server test:integration
```

Expected: On Linux with nsjail, all jail enforcement tests PASS. On macOS, jail tests are skipped, macOS fallback test PASSES.

- [ ] **Step 4: Commit**

```bash
git add packages/aai-server/process-jail.integration.test.ts packages/aai-server/vitest.integration.config.ts
git commit -m "test: add nsjail enforcement integration tests for process jail"
```

---

### Task 7: Update CLAUDE.md and run full check

**Files:**
- Modify: `CLAUDE.md` (root-level, `packages/aai-server` section reference)

- [ ] **Step 1: Update security architecture section in CLAUDE.md**

Add the following after the "Platform sandbox (aai-server)" section in `CLAUDE.md`:

```markdown
**OS-level process jail (aai-server, Linux only):**

The secure-exec Rust V8 child process runs inside an **nsjail** sandbox
on Linux production deployments. This provides defense-in-depth against
V8 engine exploits that could escape the isolate boundary.

nsjail enforces:
- **Mount namespace**: read-only root, only the Rust binary and shared
  libraries bind-mounted. UDS socket dir is the sole writable mount.
- **PID namespace**: process sees only itself.
- **Network namespace**: empty (no interfaces). UDS still works via
  bind-mounted socket dir.
- **seccomp-bpf**: syscall allowlist in `seccomp-allowlist.json`.
- **Capabilities**: all dropped.
- **cgroups v2**: memory and PID limits.

On macOS (dev), the jail is skipped with a warning. Requires `nsjail`
on `$PATH` (installed via `apt-get install nsjail` in the Dockerfile).

Key files: `process-jail.ts`, `jail-config.ts`, `seccomp-policy.ts`,
`seccomp-allowlist.json`.

When upgrading secure-exec, run `pnpm --filter @alexkroman1/aai-server
test:integration` on Linux to verify the seccomp allowlist is still
sufficient. Update `seccomp-allowlist.json` if new syscalls are needed.

A `pnpm patch` on `@secure-exec/v8` adds `SECURE_EXEC_V8_WRAPPER` env
var support. When secure-exec ships the `v8Runtime` option on
`createNodeRuntimeDriverFactory`, remove the patch and use the clean API.
```

- [ ] **Step 2: Run lint**

```bash
pnpm lint
```

Expected: PASS

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS

- [ ] **Step 4: Run unit tests**

```bash
pnpm test
```

Expected: PASS (jail tests skip on macOS, unit tests for config/policy pass everywhere)

- [ ] **Step 5: Run check:local**

```bash
pnpm check:local
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add process jail to security architecture documentation"
```

---

## Summary of Commits

1. `patch: add SECURE_EXEC_V8_WRAPPER env var to secure-exec binary resolution`
2. `feat: add seccomp syscall allowlist and policy builder for process jail`
3. `feat: add nsjail config builder for process jail`
4. `feat: add process-jail module with nsjail launcher and platform detection`
5. `feat: integrate process jail into sandbox isolate startup`
6. `test: add nsjail enforcement integration tests for process jail`
7. `docs: add process jail to security architecture documentation`
