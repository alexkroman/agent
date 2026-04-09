# Replace Firecracker with gVisor sandbox

## Motivation

The Firecracker sandbox (PR #423) cannot run on Fly.io because Fly uses
Firecracker itself to host containers -- no nested virtualization.
Firecracker requires KVM, which is unavailable in Fly VMs.

gVisor (`runsc`) provides strong process isolation via a userspace kernel
(Sentry) that intercepts syscalls in ptrace mode -- no KVM required.
It works on Fly.io, AWS, GCP, GitHub Actions, and any Linux host.

The Firecracker implementation proved out the IPC layer, guest harness,
RPC protocol, and test infrastructure. This spec replaces only the VM
layer (Firecracker) with gVisor while keeping everything else intact.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Isolation technology | gVisor (runsc) in ptrace mode | No KVM required. Works on Fly.io. |
| IPC transport | JSON-over-stdio | Same protocol as fake-vm tests (already passing). No vsock, no CONNECT handshake. |
| Agent lifecycle | Process-per-agent (unchanged) | One gVisor sandbox per slug. 30s idle timeout. Hard cap 50. |
| Cold start | ~200-300ms | gVisor Sentry init + Node.js startup. No snapshots needed. |
| Firecracker code | Full delete | No dual backend. gVisor is the only sandbox. |

## Architecture

### Process model

```
Host (Node.js)
|-- runsc sandbox: agent-abc (Node.js child, sessions 1, 2, 3)
|   \-- stdio: JSON RPC
|-- runsc sandbox: agent-xyz (Node.js child, session 4)
|   \-- stdio: JSON RPC
\-- runsc sandbox: agent-def (Node.js child, session 5)
    \-- stdio: JSON RPC
```

Each agent slug gets its own gVisor sandbox. The host spawns:

```
runsc --rootless --network=none --platform=ptrace \
  --root /tmp/runsc/<slug> \
  do -- node /path/to/harness.mjs
```

The child process's stdin/stdout is the RPC channel. Same
newline-delimited JSON protocol used by the fake-vm tests.

### What stays the same

All of these are unchanged from the Firecracker implementation:

- `vsock.ts` -- JSON-over-stream RPC protocol (works with stdio)
- `guest/harness.ts` -- guest entrypoint, concurrent RPC dispatch
- `guest/harness-logic.ts` -- tool execution, hooks, session state
- `guest/fake-vm.ts` -- macOS dev fallback (plain child process)
- `sandbox-slots.ts` -- Map + 30s idle timeout + hard cap 50
- `sandbox.ts` -- createRuntime bridge to sandbox-vm.ts
- `rpc-schemas.ts` -- all RPC message types
- `constants.ts` -- VM/sandbox constants
- All unit tests (vsock, harness, sandbox-slots, sandbox-vm)
- `fake-vm-integration.test.ts` -- 10 macOS integration tests

### What changes

**Delete (Firecracker-specific):**

| File | Reason |
|---|---|
| `firecracker.ts` | VM lifecycle manager -- no VMs |
| `snapshot.ts` | VM snapshots -- gVisor doesn't snapshot |
| `firecracker.test.ts` | Tests for deleted code |
| `firecracker-integration.test.ts` | Firecracker VM integration tests |
| `vitest.firecracker.config.ts` | Firecracker vitest config |
| `guest/build-initrd.sh` | No initrd |
| `guest/build-kernel.sh` | No kernel |
| `guest/kernel.config` | No kernel config |
| `guest/Dockerfile.firecracker` | Replaced by Dockerfile.gvisor |
| `guest/docker-test.sh` | Replaced |
| `guest/debug-boot.sh` | Not needed |

**New files:**

| File | Purpose |
|---|---|
| `gvisor.ts` | gVisor container lifecycle: spawn runsc, kill, cleanup |
| `gvisor.test.ts` | Unit tests for gvisor.ts |
| `gvisor-integration.test.ts` | Integration tests (Linux, no KVM) |
| `guest/Dockerfile.gvisor` | node:22-slim + runsc. No kernel, no initrd. |

**Modified files:**

| File | Change |
|---|---|
| `sandbox-vm.ts` | Replace `createFirecrackerSandbox` with `createGvisorSandbox`. Remove vsock handshake. IPC is stdio (same as dev sandbox). |
| `sandbox.ts` | Remove snapshot path resolution and Firecracker env vars |
| `.github/workflows/check.yml` | Replace `docker-firecracker` with `docker-gvisor` |
| `CLAUDE.md` | Replace Firecracker docs with gVisor |
| `scripts/fc-debug-server.sh` | Delete (Firecracker debug tool) |

### gVisor sandbox implementation

`gvisor.ts` exports:

- `isGvisorAvailable(): boolean` -- true on Linux when `runsc` is on PATH
- `spawnGvisorSandbox(opts): ChildProcess` -- spawns `runsc do` with the harness

`createGvisorSandbox` in `sandbox-vm.ts`:

1. `spawn("runsc", ["--rootless", "--network=none", "--platform=ptrace", "--root", stateDir, "do", "--", "node", harnessPath])`
2. Create Duplex from child stdin/stdout
3. `createRpcChannel(duplex)` -- same as dev sandbox
4. Send bundle message, wait for ok
5. Register KV handler
6. Return SandboxHandle

This is nearly identical to `createDevSandbox` except the spawn
command wraps node in `runsc`. The RPC protocol, bundle injection,
KV proxy, and shutdown are all unchanged.

### macOS dev experience

Unchanged. `createDevSandbox` via `fork()`. No gVisor on macOS.

### Testing

**Unit tests (macOS, instant):** all existing tests pass unchanged.

**Fake-VM integration (macOS, <1s):** 10 tests, unchanged.

**gVisor integration (Linux, no KVM):**

Tests run in Docker with `runsc` installed. No `--device /dev/kvm`,
no `--privileged`. May need `--security-opt seccomp=unconfined` for
gVisor's ptrace mode.

`Dockerfile.gvisor`:
```
FROM node:22-slim
RUN <install runsc from gvisor.dev apt repo>
COPY project, install deps, build
CMD pnpm vitest run --config vitest.gvisor.config.ts
```

Test cases:
1. Bundle injection + tool execution
2. KV round-trip through host proxy
3. Cross-agent isolation (two runsc processes, separate memory)
4. Agent cannot access host filesystem
5. Agent cannot access network
6. Error propagation from tool throws
7. Shutdown message causes process exit

### Security model

| Property | gVisor |
|---|---|
| Cross-agent isolation | Separate gVisor sandboxes, separate Sentry instances |
| Post-escape surface | Go userspace kernel (not real Linux kernel) |
| Network isolation | `--network=none` (no interfaces) |
| Filesystem isolation | gVisor controls FS access |
| Process isolation | Separate PID namespace via gVisor |
| macOS dev | No isolation (same as before) |

### Deployment

Works on:
- Fly.io (no KVM needed)
- AWS ECS/EC2
- GCP Cloud Run / GKE
- GitHub Actions `ubuntu-latest`
- Any Linux host with `runsc` installed
