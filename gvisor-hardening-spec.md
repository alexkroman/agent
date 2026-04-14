# gVisor Sandbox Hardening Spec

## Goal

Migrate from `runsc do` (lightweight mode) to `runsc run` with a full OCI
runtime spec. Harden all security boundaries: seccomp denylist, capability
drops, resource limits via rlimits, mount hardening, Deno permission
tightening, and proc masking.

**Threat model:** Full spectrum — malicious agent authors, compromised
dependencies, and resource abuse.

**Deployment target:** Firecracker VMs on Fly.io (no host cgroup delegation
assumed).

## Approach

- Clean break — rewrite the gVisor layer, no backwards compat with `runsc do`
- All security config generated programmatically in a single typed module
- Resource limits via rlimits (not cgroups) for Firecracker compatibility
- Seccomp denylist on top of gVisor defaults (not a strict allowlist)
- Operator-only overrides for resource limits (agent authors cannot set them)

---

## 1. OCI Spec Generation & Sandbox Lifecycle

### New module: `oci-spec.ts`

A single function `buildOciSpec(opts)` returns a complete OCI runtime spec
object. All security configuration lives here.

**Inputs:**

- `rootfsPath: string` — path to the prepared rootfs directory
- `harnessPath: string` — path to deno-harness.mjs inside rootfs
- `denoPath: string` — path to Deno binary inside rootfs
- `memoryLimitBytes?: number` — default 67,108,864 (64 MB)
- `pidLimit?: number` — default 32
- `tmpfsSizeBytes?: number` — default 10,485,760 (10 MB)

**Output:** Typed OCI `RuntimeSpec` object containing:

- **Process**: Deno command + args (`--no-prompt`, no `--allow-env`), minimal
  env, `cwd: "/tmp"`, `noNewPrivileges: true`
- **Mounts**: read-only bind mount for rootfs, size-limited tmpfs at `/tmp`
- **Linux namespaces**: pid, mount, ipc, uts (no network namespace —
  `--network=none` handled by runsc flag)
- **Linux resources**: rlimits for memory, PIDs, CPU, file descriptors
- **Capabilities**: all dropped (empty bounding, effective, permitted,
  inheritable, ambient sets)
- **Seccomp**: denylist profile (see Section 3)

### Revised `gvisor.ts`

Replace `runsc do` spawn with full OCI lifecycle:

1. `runsc create --bundle <dir> <container-id>` — creates container from spec
2. `runsc start <container-id>` — starts the process
3. `runsc wait <container-id>` — wait for exit (non-blocking, monitored)
4. `runsc delete <container-id>` — cleanup on teardown

NDJSON transport attaches to the container's stdio (terminal: false in spec).
Container IDs: `aai-<slug>-<nanoid(8)>`.

### Cleanup guarantees

- `runsc delete` in a `finally` block on every exit path
- Stale container reaping on server startup (`runsc list` + delete `aai-*`)
- Graceful shutdown: `shutdown` NDJSON message before `runsc kill`

---

## 2. Resource Limits (rlimits, no cgroups)

Enforced via OCI spec `process.rlimits` and Deno/V8 flags. No host cgroup
delegation required — works in Firecracker VMs on Fly.io.

### Per-sandbox defaults

| Resource | Mechanism | Default |
|---|---|---|
| Memory | Deno `--v8-flags=--max-heap-size=64` + `RLIMIT_AS` | 64 MB |
| PIDs | `RLIMIT_NPROC` | 32 |
| tmpfs | Mount option `size=10m` | 10 MB |
| CPU time | `RLIMIT_CPU` | 60 seconds (cumulative per process) |
| File descriptors | `RLIMIT_NOFILE` | 256 |

### Operator overrides

`SandboxResourceLimits` type in `sandbox-vm.ts`:

```typescript
type SandboxResourceLimits = {
  memoryLimitBytes?: number      // default 64 MB
  pidLimit?: number              // default 32
  tmpfsSizeBytes?: number        // default 10 MB
  cpuTimeLimitSecs?: number      // default 60
}
```

Set via server environment variables:

- `SANDBOX_MEMORY_LIMIT_MB` (range: 16–512)
- `SANDBOX_PID_LIMIT` (range: 8–256)
- `SANDBOX_TMPFS_LIMIT_MB` (range: 1–100)
- `SANDBOX_CPU_TIME_LIMIT_SECS` (range: 10–300)

Agent authors cannot set these. Validation enforces sane ranges.

Keep `--ignore-cgroups` — correct flag for Firecracker environments.

---

## 3. Seccomp Denylist Profile

Default action: `SCMP_ACT_ALLOW`. Denied syscalls return `SCMP_ACT_ERRNO`
with `EPERM` (clean error, not process kill).

### Denied syscalls

| Syscall | Category |
|---|---|
| `ptrace` | Process debugging / escape |
| `mount`, `umount2` | Filesystem manipulation |
| `pivot_root`, `chroot` | Root filesystem changes |
| `reboot` | System disruption |
| `sethostname`, `setdomainname` | Namespace manipulation |
| `init_module`, `finit_module`, `delete_module` | Kernel module loading |
| `kexec_load`, `kexec_file_load` | Kernel replacement |
| `unshare` | Namespace creation |
| `setns` | Namespace joining |
| `personality` | Execution domain change |
| `userfaultfd` | Exploitation primitive |
| `perf_event_open` | Side-channel leaks |
| `bpf` | BPF program loading |
| `keyctl`, `request_key`, `add_key` | Kernel keyring access |
| `acct` | Process accounting |
| `quotactl` | Filesystem quota manipulation |
| `syslog` | Kernel log access |
| `vhangup` | Terminal hijacking |

Generated inline by `buildOciSpec()` in the `linux.seccomp` field — not a
separate file.

---

## 4. Capability Drops & Process Hardening

### Capabilities

All dropped. Empty arrays for bounding, effective, permitted, inheritable,
and ambient sets. Deno needs no Linux capabilities.

### Process fields

| Field | Value | Effect |
|---|---|---|
| `noNewPrivileges` | `true` | No setuid/setgid privilege escalation |
| `oomScoreAdj` | `1000` | Sandbox killed first under memory pressure |
| `user.uid` / `user.gid` | `65534` (nobody) | Non-root inside sandbox |

### Mount hardening

| Mount | Options |
|---|---|
| rootfs `/` | `ro,nosuid,nodev` |
| `/tmp` | `rw,noexec,nosuid,nodev,size=10m` |
| `/proc` | `ro` with masked + readonly paths |
| `/dev` | Minimal: `/dev/null`, `/dev/zero`, `/dev/urandom` only |

### Proc masking

```json
{
  "maskedPaths": [
    "/proc/kcore", "/proc/keys", "/proc/latency_stats",
    "/proc/timer_list", "/proc/sched_debug", "/proc/scsi"
  ],
  "readonlyPaths": [
    "/proc/asound", "/proc/bus", "/proc/fs",
    "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"
  ]
}
```

---

## 5. Deno Permission Tightening

### Remove `--allow-env`

Agent env vars already delivered via NDJSON `bundle/load` message. The
`--allow-env` flag is vestigial. Remove it.

**Audit during implementation:** Deno may read env vars internally (e.g.
`DENO_DIR`, `NO_COLOR`). Any required vars go in the OCI spec's
`process.env` array.

### Final Deno command

```
deno run --no-prompt /path/to/deno-harness.mjs
```

No `--allow-*` flags. Communication entirely over stdin/stdout NDJSON.

### OCI process.env

Minimal explicit allowlist:

```json
["PATH=/usr/bin:/bin", "HOME=/tmp", "NO_COLOR=1"]
```

No `AAI_*` vars, no platform secrets, no host env leakage.

---

## 6. OCI Lifecycle & Cleanup

### Container lifecycle

```
create  →  start  →  [NDJSON communication]  →  kill/wait  →  delete
```

1. Prepare bundle dir — write `config.json` from `buildOciSpec()`, symlink rootfs
2. `runsc create --bundle <dir> <id>`
3. `runsc start <id>` — NDJSON transport attaches to stdio
4. Normal operation — `bundle/load`, `tool/execute`, etc.
5. Teardown — `shutdown` NDJSON, `runsc kill <id> SIGTERM`, `runsc wait <id>`
   (5s timeout), `runsc delete <id>`
6. Force kill — if wait times out, `SIGKILL` + `runsc delete --force <id>`

### Container IDs

`aai-<slug>-<nanoid(8)>` — e.g. `aai-pizza-bot-k3x9m2p1`

### Stale reaping (server startup)

1. `runsc list` — find `aai-*` containers
2. `runsc delete --force` each
3. Log count reaped

### Bundle dir cleanup

Temp dirs in `/tmp/aai-bundles/<container-id>/`. Deleted in `finally` block.
Orphans cleaned on startup.

### Error handling

- `runsc create` fail → clean up bundle dir, throw with stderr
- `runsc start` fail → `runsc delete`, clean up, throw
- NDJSON parse error → log, continue
- Guest exit → `runsc wait` returns exit code, `runsc delete`, report to session

---

## 7. Integration Tests

### Updated existing tests

All rewritten against `runsc run` lifecycle, same assertions:

- Bundle load + tool execution
- KV round-trip
- Cross-agent isolation
- Filesystem read-only
- Network isolation
- Graceful shutdown
- Stale reaping

### New security tests

| Test | Verifies |
|---|---|
| Seccomp denylist | Each denied syscall returns `EPERM` |
| Capability drops | Privileged ops (`chown`, `setuid`) fail |
| Memory rlimit | Allocation beyond 64 MB kills process |
| PID rlimit | 33+ processes returns `EAGAIN` |
| tmpfs size limit | >10 MB write returns `ENOSPC` |
| No env leakage | `Deno.env.toObject()` returns empty or throws |
| Proc masking | `/proc/keys`, `/proc/kcore` blocked |
| OomScoreAdj | `/proc/self/oom_score_adj` reads 1000 |

### Unit tests for `oci-spec.ts`

- `buildOciSpec()` returns valid OCI runtime spec
- Default resource limits correct
- Operator overrides applied and validated
- Invalid overrides throw
- Seccomp denylist complete
- Capabilities all empty
- Mount options correct

### Test infrastructure

Gated on `runsc` availability, skipped on macOS. Run via `docker-test.sh`.

---

## 8. Files Changed

| File | Change |
|---|---|
| `packages/aai-server/oci-spec.ts` | **New** — spec generation, types, seccomp, all config |
| `packages/aai-server/gvisor.ts` | **Rewrite** — `runsc run` lifecycle, reaping, bundle dirs |
| `packages/aai-server/sandbox-vm.ts` | **Update** — resource limits, operator env vars, validation |
| `packages/aai-server/sandbox.ts` | **Minor** — thread resource limits through |
| `packages/aai-server/Dockerfile` | **Update** — adjust for `runsc run` mode |
| `packages/aai-server/gvisor-integration.test.ts` | **Rewrite** — new lifecycle + security tests |
| `packages/aai-server/oci-spec.test.ts` | **New** — unit tests for spec generation |

### Unchanged

- `guest/deno-harness.ts` — NDJSON protocol unchanged
- `ndjson-transport.ts`
- `ssrf.ts`
- Dev mode fallback (macOS)
- CLI, UI, core SDK packages
