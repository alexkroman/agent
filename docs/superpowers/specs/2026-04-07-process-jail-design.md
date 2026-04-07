# Process Jail Design: OS-Level Sandbox for secure-exec

**Date:** 2026-04-07
**Status:** Approved
**Branch:** feature/process-security

## Problem

Agent code runs in secure-exec V8 isolates, which provide application-level
isolation (virtual filesystem, bridge-mediated permissions, memory/CPU limits).
However, the Rust V8 child process itself runs with the same OS privileges as
the host Node.js process. If a V8 engine exploit achieves arbitrary code
execution in the Rust process (bypassing the bridge layer), the attacker gains
full host filesystem access, network access, and the ability to interact with
other sandbox processes.

V8 exploits exist in the wild (Chrome bug bounty regularly pays for them).
For a platform running untrusted agent code from arbitrary users, an OS-level
defense-in-depth layer is warranted.

## Solution

Wrap the secure-exec Rust V8 child process in an **nsjail** sandbox on Linux.
nsjail is Google's server-grade sandboxing tool that applies Linux namespaces,
seccomp-bpf, capability dropping, and cgroup resource limits to a target
process. On macOS (dev mode), skip OS sandboxing with a logged warning and
rely on secure-exec's existing isolation.

### Why nsjail over alternatives

| Tool | Verdict | Reason |
|------|---------|--------|
| **nsjail** | Chosen | Built by Google for server-side sandboxing of untrusted code. Native cgroup v2, seccomp policy language, process monitoring. Battle-tested in production. |
| **Bubblewrap (bwrap)** | Rejected | Desktop-first (Flatpak). Relies on user namespaces (`CLONE_NEWUSER`), which are disabled on some hardened servers. No built-in cgroup support. |
| **Custom Rust wrapper** | Rejected | Duplicates what nsjail does. High implementation/maintenance burden for security-critical code. |
| **Landlock LSM** | Rejected | Requires kernel 5.13+. No PID/network namespace isolation. Can't restrict the child process from the parent without native addon. |
| **gVisor** | Rejected | Strongest isolation but requires OCI runtime. Too heavy for wrapping a single binary. |

### Why not apply sandboxing inside secure-exec

Cloudflare's workerd applies seccomp/namespaces from inside the runtime process
before executing user code. We don't control the secure-exec Rust binary's
internals, so we wrap it externally. This keeps AAI decoupled from secure-exec
internals.

## Architecture

```
Host Node.js process
  └── sandbox.ts → startIsolate()
        └── process-jail.ts (NEW)
              ├── Linux: spawns nsjail → Rust V8 binary (jailed)
              └── macOS: spawns Rust V8 binary directly (warning logged)
                    └── UDS socket (bind-mounted into jail)
```

### Integration point

`createV8Runtime()` accepts a `binaryPath` option but hardcodes an empty args
array (`spawn(binaryPath, [])`). We cannot pass nsjail arguments through
`binaryPath` alone. The solution is a **wrapper shell script**:

1. `createJailedLauncher()` writes a temporary shell script:
   ```sh
   #!/bin/sh
   exec nsjail --config /tmp/<sandbox-id>/jail.cfg -- /path/to/real-binary
   ```
2. The nsjail config file (`jail.cfg`) is also written to the temp directory.
3. `binaryPath` is set to this wrapper script.
4. secure-exec spawns the script, which `exec`s nsjail, which `exec`s the
   Rust binary inside the jail.
5. Cleanup: the wrapper script and config file are removed on sandbox shutdown.

On macOS, the original binary path passes through unchanged.

## Restriction Layers

The nsjail configuration enforces six restriction layers:

### 1. Mount namespace (read-only root)

- Bind-mount the Rust V8 binary: **read-only**
- Bind-mount required shared libraries (`/lib`, `/lib64`, `/usr/lib`): **read-only**
- Bind-mount `/tmp/<sandbox-id>/`: **read-write** (for UDS socket only)
- Mount minimal `/proc`: **read-only**, `hidepid=2`
- No access to host filesystem, home directories, `/etc`, or any other paths

### 2. PID namespace

- Sandboxed process sees only itself (PID 1)
- Cannot signal, inspect, or enumerate host processes

### 3. Network namespace

- Empty network namespace: no interfaces except loopback
- The UDS socket works via the bind-mounted `/tmp` path (Unix domain sockets
  do not require network interfaces)
- No TCP/UDP egress possible — the Rust binary only needs the UDS socket for
  IPC back to the host

### 4. seccomp-bpf filter

- **Allowlist approach**: permit only syscalls the Rust V8 runtime needs
- Expected allowlist (to be finalized by profiling with `strace`):
  `read`, `write`, `close`, `mmap`, `mprotect`, `munmap`, `brk`, `futex`,
  `epoll_ctl`, `epoll_wait`, `epoll_create1`, `clock_gettime`,
  `clock_getres`, `getrandom`, `sigaltstack`, `rt_sigaction`,
  `rt_sigprocmask`, `sched_yield`, `nanosleep`, `exit_group`, `exit`,
  `newfstatat`, `fstat`, `openat`, `recvmsg`, `sendmsg`, `socket`,
  `connect`, `bind`, `listen`, `accept4`, `getsockname`, `getpeername`,
  `setsockopt`, `getsockopt`, `poll`, `ppoll`, `ioctl`, `fcntl`,
  `dup`, `dup2`, `pipe2`, `eventfd2`, `timerfd_create`, `timerfd_settime`,
  `readv`, `writev`, `lseek`, `mremap`, `madvise`, `getpid`, `gettid`,
  `set_robust_list`, `prctl`, `arch_prctl`, `clone3`, `wait4`, `tgkill`
- **Denied explicitly**: `execve` (after initial exec via nsjail),
  `execveat`, `ptrace`, `mount`, `umount2`, `reboot`, `kexec_load`,
  `init_module`, `finit_module`, `delete_module`, `pivot_root`,
  `swapon`, `swapoff`, `acct`, `settimeofday`, `adjtimex`, `sethostname`,
  `setdomainname`, `ioperm`, `iopl`, `modify_ldt`
- The exact allowlist will be derived by profiling the Rust binary under
  normal operation with `strace -c` and stored in `seccomp-allowlist.json`

### 5. Capability dropping

- Drop **all** Linux capabilities
- The Rust V8 binary needs zero capabilities for normal operation

### 6. cgroups v2 resource limits

- **Memory**: `SANDBOX_MEMORY_LIMIT_MB` (128 MB) + Rust runtime overhead =
  **256 MB** total
- **PID limit**: 1 (no forking allowed)
- **CPU**: Optional — secure-exec already enforces CPU time per V8 session

## New Files

| File | Purpose |
|------|---------|
| `packages/aai-server/process-jail.ts` | Core module: platform detection, `createJailedLauncher()`, `isJailAvailable()` |
| `packages/aai-server/jail-config.ts` | Builds nsjail protobuf text config from `JailOptions` |
| `packages/aai-server/seccomp-policy.ts` | Generates the seccomp-bpf syscall allowlist |
| `packages/aai-server/seccomp-allowlist.json` | Checked-in syscall allowlist for regression detection |
| `packages/aai-server/process-jail.integration.test.ts` | Jail enforcement, smoke, regression, and macOS fallback tests |

## Public API

### `process-jail.ts`

```ts
interface JailOptions {
  /** Path to the Rust V8 binary */
  binaryPath: string;
  /** Directory for the UDS socket */
  socketDir: string;
  /** Memory limit in MB (for cgroup) */
  memoryLimitMb: number;
  /** Sandbox ID (used for unique mount paths) */
  sandboxId: string;
}

interface JailedLauncher {
  /** Path to wrapper script (Linux) or original binary (macOS) */
  binaryPath: string;
  /** Cleanup function: removes temp wrapper script and config on shutdown */
  cleanup(): Promise<void>;
}

/** Build a jailed launcher for the Rust V8 binary. Returns the wrapper
 *  script path as binaryPath. Caller must invoke cleanup() on shutdown. */
function createJailedLauncher(options: JailOptions): Promise<JailedLauncher>;

/** Check if nsjail is available on this platform. */
function isJailAvailable(): boolean;
```

### `jail-config.ts`

```ts
/** Generate nsjail protobuf text config. */
function buildJailConfig(options: JailOptions): string;
```

### `seccomp-policy.ts`

```ts
/** Load the seccomp allowlist and generate a policy string for nsjail. */
function buildSeccompPolicy(): string;
```

## Modified Files

### `packages/aai-server/sandbox.ts`

Change to `startIsolate()`: before calling `createV8Runtime()`, check
`isJailAvailable()`. If true, call `createJailedLauncher()` to get a
wrapper script path, and pass it as `binaryPath` to `createV8Runtime()`.
Call `launcher.cleanup()` during sandbox shutdown (in `shutdownSandbox()`).
If false, log a warning and proceed as today.

The change is small and localized to the isolate startup and shutdown paths.

## nsjail Binary Distribution

nsjail is **not** bundled as an npm dependency. It is discovered on `$PATH`
at runtime.

- **Production (Docker/K8s):** Add to Dockerfile:
  ```dockerfile
  RUN apt-get update && apt-get install -y nsjail && rm -rf /var/lib/apt/lists/*
  ```
- **Development (macOS):** Not available, jail is skipped with warning.
- **CI (Linux runners):** Install nsjail in the CI image or as a setup step.

`isJailAvailable()` checks: `process.platform === "linux"` AND `nsjail`
is found on `$PATH`. Returns `false` on macOS or when nsjail is not installed.

## macOS Behavior

On macOS (or any non-Linux platform, or Linux without nsjail installed):

1. `isJailAvailable()` returns `false`
2. `startIsolate()` logs: `"OS-level process jail unavailable (platform: darwin). Relying on secure-exec isolation only."`
3. `createV8Runtime()` is called with the original binary path, no wrapping
4. All existing secure-exec isolation continues to apply

## Testing Strategy

### 1. Jail enforcement tests

Run only on Linux CI. Spawn a jailed test process (shell script, not the real
Rust binary) and verify each restriction:

| Test | Verification |
|------|-------------|
| Filesystem read-only | Attempt `touch /file` → EROFS or EPERM |
| Filesystem restricted | Attempt `cat /etc/passwd` → ENOENT |
| PID namespace | `/proc` shows only PID 1 |
| Network namespace | Attempt TCP connect → ENETUNREACH |
| UDS works | Send/receive message over bind-mounted UDS socket |
| Memory cgroup | Allocate beyond limit → OOM killed |
| PID limit | Attempt `fork()` → EAGAIN |
| seccomp | Attempt `ptrace` → EPERM or SIGSYS |

### 2. Smoke test: real sandbox in jail

Run the existing `sandbox-integration.test.ts` boot flow but with the jail
enabled. Confirms the Rust binary works under nsjail restrictions (seccomp
allowlist isn't too tight, bind-mounts are sufficient).

### 3. Seccomp allowlist regression

- During the smoke test, optionally record syscalls via `strace -c`
- Compare against `seccomp-allowlist.json`
- If a secure-exec upgrade introduces new syscalls, the smoke test fails
  with a clear message to update the allowlist

### 4. macOS fallback test

- Verify `isJailAvailable()` returns `false` on macOS
- Verify the warning is logged
- Verify the sandbox works end-to-end without the jail

### 5. CI gating

- Jail enforcement tests: Linux CI only, integration test tier (30s timeout)
- Smoke test: Linux CI only, integration test tier
- macOS fallback: runs on all platforms, unit test tier

## Security Considerations

- **nsjail itself is a dependency.** It must be kept updated. Pin to a
  specific version in the Dockerfile and bump deliberately.
- **seccomp allowlist maintenance.** When upgrading secure-exec, run the
  smoke test on Linux to verify the allowlist is still sufficient. If the
  Rust binary needs new syscalls, update `seccomp-allowlist.json` after
  reviewing the new syscalls.
- **User namespace requirement.** nsjail uses `CLONE_NEWUSER` by default.
  If the production kernel has `kernel.unprivileged_userns_clone=0`, nsjail
  must run as root (typical in Docker containers where the process is
  already root) or the sysctl must be enabled.
- **UDS socket path length.** Unix domain socket paths are limited to 108
  bytes. The `/tmp/<sandbox-id>/` path must stay within this limit.
  Use short sandbox IDs (8 hex chars).
- **Environment variable forwarding.** secure-exec passes `SECURE_EXEC_V8_TOKEN`
  and other env vars to the child process via `spawn()`. The wrapper script
  inherits these automatically. nsjail must be configured to pass the
  inherited environment through to the jailed process (nsjail's default
  behavior is to clear the environment; use `pass_env` directives in the
  config for required variables).
- **Wrapper script permissions.** The temp wrapper script must be executable
  (`chmod 0700`). The temp directory should be created with restricted
  permissions (`0700`) to prevent other users from modifying the script
  between creation and execution (TOCTOU).
