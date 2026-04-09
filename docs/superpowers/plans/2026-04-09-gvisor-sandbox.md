# gVisor + vscode-jsonrpc Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Firecracker VMs with gVisor sandboxes and replace hand-rolled RPC with vscode-jsonrpc. Deploy on Fly.io (no KVM). Minimize lines of code.

**Architecture:** Each agent runs in a gVisor OCI sandbox (`runsc run`) with cgroup limits. Host↔guest communicate via `vscode-jsonrpc` over stdio. The hand-rolled `vsock.ts` protocol layer is deleted entirely.

**Tech Stack:** gVisor runsc (OCI mode, systrap platform), vscode-jsonrpc, Node.js, vitest

**Spec:** `docs/superpowers/specs/2026-04-09-gvisor-sandbox-design.md`

---

## File Structure

### Files to delete

| File | Lines | Reason |
|---|---|---|
| `vsock.ts` | 121 | Replaced by vscode-jsonrpc |
| `vsock.test.ts` | 173 | Tests for deleted code |
| `firecracker.ts` | 220 | No VMs |
| `firecracker.test.ts` | 125 | Tests for deleted code |
| `snapshot.ts` | 86 | No snapshots |
| `guest/fake-vm.ts` | 51 | Rewritten |
| `firecracker-integration.test.ts` | ~800 | Replaced |
| `vitest.firecracker.config.ts` | 11 | Replaced |
| `guest/build-initrd.sh` | ~100 | No initrd |
| `guest/build-kernel.sh` | ~70 | No kernel |
| `guest/kernel.config` | ~130 | No kernel |
| `guest/Dockerfile.firecracker` | ~130 | Replaced |
| `guest/docker-test.sh` | ~30 | Replaced |
| `guest/debug-boot.sh` | ~100 | Not needed |
| `scripts/fc-debug-server.sh` | ~90 | Not needed |

### New files

| File | Purpose |
|---|---|
| `packages/aai-server/gvisor.ts` | gVisor availability check, OCI spec generation, sandbox spawn |
| `packages/aai-server/gvisor.test.ts` | Unit tests |
| `packages/aai-server/gvisor-integration.test.ts` | Integration tests (Linux, no KVM) |
| `packages/aai-server/vitest.gvisor.config.ts` | gVisor vitest config |
| `packages/aai-server/guest/Dockerfile.gvisor` | node:22-slim + runsc |
| `packages/aai-server/guest/docker-test.sh` | gVisor Docker test runner |

### Files to rewrite

| File | Change |
|---|---|
| `sandbox-vm.ts` | Delete Firecracker + vsock code. One `createSandbox` using jsonrpc over stdio. |
| `sandbox-vm.test.ts` | Simplify for new implementation |
| `guest/harness.ts` | Replace hand-rolled RPC with jsonrpc connection |
| `guest/harness.test.ts` | Update for jsonrpc |
| `guest/fake-vm.ts` | Simplify — just spawn harness + connect jsonrpc |
| `fake-vm-integration.test.ts` | Update RPC calls to use jsonrpc |

### Files to edit

| File | Change |
|---|---|
| `sandbox.ts` | Remove snapshot/Firecracker refs |
| `.github/workflows/check.yml` | docker-firecracker → docker-gvisor |
| `CLAUDE.md` | Firecracker → gVisor docs |
| `packages/aai-server/package.json` | Add vscode-jsonrpc dep, remove test:firecracker |
| `knip.json` | Update entries |

### Unchanged

| File | Why unchanged |
|---|---|
| `guest/harness-logic.ts` | Tool execution, hooks, state — transport-agnostic |
| `sandbox-slots.ts` + test | Map + idle timeout — transport-agnostic |
| `rpc-schemas.ts` | Zod schemas for message validation (still useful) |
| `constants.ts` | Sandbox constants |
| `sandbox.ts` (mostly) | createRuntime bridge — only remove snapshot refs |

---

## Task 1: Add vscode-jsonrpc dependency

**Files:**
- Modify: `packages/aai-server/package.json`

- [ ] **Step 1: Install vscode-jsonrpc**

```bash
cd packages/aai-server
pnpm add vscode-jsonrpc
```

- [ ] **Step 2: Verify it installed**

```bash
node -e "require('vscode-jsonrpc')"
```

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/package.json pnpm-lock.yaml
git commit -m "deps(aai-server): add vscode-jsonrpc for host↔guest RPC"
```

---

## Task 2: Rewrite guest/harness.ts with jsonrpc

Replace the hand-rolled RPC dispatch loop with a vscode-jsonrpc connection.

**Files:**
- Rewrite: `packages/aai-server/guest/harness.ts`
- Rewrite: `packages/aai-server/guest/harness.test.ts`

- [ ] **Step 1: Rewrite harness.ts**

The new harness is dramatically simpler. The entire file:

```typescript
// packages/aai-server/guest/harness.ts
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Readable, Writable } from "node:stream";
import {
  executeTool,
  initHarness,
  invokeHook,
  resetAgentEnv,
  type KvInterface,
} from "./harness-logic.ts";

/**
 * Creates a jsonrpc connection and wires up tool/hook/shutdown handlers.
 * Returns the connection and a KV proxy for the guest to call host KV.
 */
export function createGuestConnection(input: Readable, output: Writable) {
  const conn = createMessageConnection(
    new StreamMessageReader(input),
    new StreamMessageWriter(output),
  );

  const kv: KvInterface = {
    async get(key) {
      return conn.sendRequest("kv/get", { key });
    },
    async set(key, value, opts) {
      await conn.sendRequest("kv/set", { key, value, expireIn: opts?.expireIn });
    },
    async del(key) {
      await conn.sendRequest("kv/del", { key });
    },
  };

  return { conn, kv };
}

/**
 * Main entrypoint for the guest. Waits for bundle, loads agent, handles RPCs.
 */
export async function main(input: Readable, output: Writable) {
  const { conn, kv } = createGuestConnection(input, output);

  // Wait for bundle from host
  const bundle = await new Promise<{ code: string; env: Record<string, string> }>(
    (resolve) => {
      conn.onRequest("bundle/load", (params: { code: string; env: Record<string, string> }) => {
        resolve(params);
        return { ok: true };
      });
      conn.listen();
    },
  );

  // Set env vars
  for (const [k, v] of Object.entries(bundle.env)) {
    process.env[`AAI_ENV_${k}`] = v;
  }
  resetAgentEnv();

  // Load agent bundle
  const mod = { exports: {} as Record<string, unknown> };
  const loadFn = Function("module", "exports", bundle.code);
  loadFn(mod, mod.exports);
  const agent = (mod.exports.default ?? mod.exports) as Parameters<typeof initHarness>[0];

  const { sessionState, hooks } = initHarness(agent, kv);

  // Register RPC methods
  conn.onRequest("tool/execute", (params) =>
    executeTool(agent, params, sessionState, kv),
  );

  conn.onRequest("hook/invoke", (params) =>
    invokeHook(hooks, params, sessionState),
  );

  conn.onNotification("shutdown", () => {
    conn.dispose();
    process.exit(0);
  });

  // Keep alive
  await new Promise<never>(() => {});
}

// Auto-start when run directly (inside gVisor sandbox or as standalone)
if (process.argv[1]?.endsWith("harness.mjs") || process.argv[1]?.endsWith("harness.ts")) {
  main(process.stdin, process.stdout);
}
```

That's ~80 lines vs the current 290. The entire hand-rolled readline/JSON-framing/id-matching protocol is gone.

- [ ] **Step 2: Rewrite harness.test.ts**

Test `createGuestConnection` with mock streams. The tests are simpler because vscode-jsonrpc handles framing — we just test that methods are registered and return correct results.

Key tests:
1. tool/execute dispatches to executeTool
2. hook/invoke dispatches to invokeHook  
3. KV proxy sends requests to host
4. shutdown notification exits process

Use `vscode-jsonrpc` test utilities or create a mock connection pair.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run packages/aai-server/guest/harness.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/aai-server/guest/harness.ts packages/aai-server/guest/harness.test.ts
git commit -m "refactor(aai-server): rewrite guest harness with vscode-jsonrpc"
```

---

## Task 3: Rewrite sandbox-vm.ts with gVisor + jsonrpc

Replace Firecracker sandbox and vsock with gVisor OCI sandbox and jsonrpc.

**Files:**
- Rewrite: `packages/aai-server/sandbox-vm.ts`
- Create: `packages/aai-server/gvisor.ts`
- Rewrite: `packages/aai-server/sandbox-vm.test.ts`
- Create: `packages/aai-server/gvisor.test.ts`

- [ ] **Step 1: Create gvisor.ts**

```typescript
// packages/aai-server/gvisor.ts
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
 * Creates a gVisor OCI sandbox with a minimal rootfs containing
 * only the node binary and harness script.
 */
export function createGvisorSandbox(opts: {
  slug: string;
  harnessPath: string;
  memoryLimitBytes?: number;
  pidsLimit?: number;
}): GvisorSandbox {
  const bundleDir = mkdtempSync(join(tmpdir(), `aai-gvisor-${opts.slug}-`));
  const rootfsDir = join(bundleDir, "rootfs");

  // Create minimal rootfs
  mkdirSync(join(rootfsDir, "app"), { recursive: true });
  mkdirSync(join(rootfsDir, "tmp"), { recursive: true });

  // Copy node binary and harness into rootfs
  cpSync(process.execPath, join(rootfsDir, "node"));
  cpSync(opts.harnessPath, join(rootfsDir, "app", "harness.mjs"));

  // Generate OCI config.json
  const config = {
    ociVersion: "1.0.0",
    process: {
      args: ["/node", "/app/harness.mjs"],
      cwd: "/",
      env: ["PATH=/"],
    },
    root: { path: "rootfs", readonly: true },
    mounts: [
      { destination: "/tmp", type: "tmpfs", source: "tmpfs", options: ["nosuid", "nodev", "size=16m"] },
    ],
    linux: {
      namespaces: [
        { type: "pid" },
        { type: "ipc" },
        { type: "mount" },
        { type: "network" },
      ],
      resources: {
        memory: { limit: opts.memoryLimitBytes ?? 67108864 },
        pids: { limit: opts.pidsLimit ?? 32 },
      },
    },
  };

  writeFileSync(join(bundleDir, "config.json"), JSON.stringify(config, null, 2));

  // Run the sandbox
  const containerId = `aai-${opts.slug}-${Date.now()}`;
  const child = spawn(
    "runsc",
    ["--platform=systrap", "--network=none", "run", "--bundle", bundleDir, containerId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  return {
    process: child,
    async cleanup() {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.on("exit", resolve));
      // Clean up runsc state
      try { execFileSync("runsc", ["delete", "--force", containerId], { stdio: "ignore" }); } catch {}
      rmSync(bundleDir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Rewrite sandbox-vm.ts**

The new file is much simpler — one shared function for both dev and gVisor:

```typescript
// packages/aai-server/sandbox-vm.ts
import { fork, type ChildProcess } from "node:child_process";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Storage, StorageValue } from "unstorage";
import { createGvisorSandbox, isGvisorAvailable, type GvisorSandbox } from "./gvisor.ts";

export type SandboxHandle = {
  conn: MessageConnection;
  shutdown(): Promise<void>;
};

export type SandboxOptions = {
  slug: string;
  workerCode: string;
  agentEnv: Record<string, string>;
  harnessPath: string;
  kvStorage?: Storage;
  kvPrefix?: string;
};

async function configureSandbox(
  conn: MessageConnection,
  opts: SandboxOptions,
  cleanup: () => Promise<void>,
): Promise<SandboxHandle> {
  conn.listen();

  // Register KV handler (host serves guest KV requests)
  if (opts.kvStorage && opts.kvPrefix) {
    const storage = opts.kvStorage;
    const prefix = opts.kvPrefix;
    conn.onRequest("kv/get", async (p: { key: string }) => storage.getItem(`${prefix}:${p.key}`));
    conn.onRequest("kv/set", async (p: { key: string; value: unknown }) => {
      await storage.setItem(`${prefix}:${p.key}`, p.value as StorageValue);
    });
    conn.onRequest("kv/del", async (p: { key: string }) => storage.removeItem(`${prefix}:${p.key}`));
  }

  // Send bundle
  await conn.sendRequest("bundle/load", { code: opts.workerCode, env: opts.agentEnv });

  return {
    conn,
    async shutdown() {
      conn.sendNotification("shutdown");
      conn.dispose();
      await cleanup();
    },
  };
}

function createConnection(child: ChildProcess): MessageConnection {
  return createMessageConnection(
    new StreamMessageReader(child.stdout!),
    new StreamMessageWriter(child.stdin!),
  );
}

export async function createDevSandbox(opts: SandboxOptions): Promise<SandboxHandle> {
  const child = fork(opts.harnessPath, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  return configureSandbox(createConnection(child), opts, async () => {
    child.kill("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 2000);
      child.on("exit", () => { clearTimeout(t); r(); });
    });
  });
}

export async function createGvisorSandboxHandle(opts: SandboxOptions): Promise<SandboxHandle> {
  const gvisor = createGvisorSandbox({
    slug: opts.slug,
    harnessPath: opts.harnessPath,
  });

  return configureSandbox(createConnection(gvisor.process), opts, () => gvisor.cleanup());
}

export async function createSandboxVm(opts: SandboxOptions): Promise<SandboxHandle> {
  if (isGvisorAvailable()) return createGvisorSandboxHandle(opts);
  return createDevSandbox(opts);
}
```

That's ~80 lines vs the current 304. The vsock handshake, Duplex wiring, and hand-rolled RPC are all gone.

- [ ] **Step 3: Create gvisor.test.ts**

Test `isGvisorAvailable` (returns false on non-Linux) and the OCI config generation.

- [ ] **Step 4: Rewrite sandbox-vm.test.ts**

Test `configureSandbox` with mock jsonrpc connections, KV handler, and factory routing.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/aai-server/sandbox-vm.test.ts packages/aai-server/gvisor.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/aai-server/gvisor.ts packages/aai-server/gvisor.test.ts \
       packages/aai-server/sandbox-vm.ts packages/aai-server/sandbox-vm.test.ts
git commit -m "feat(aai-server): gVisor OCI sandbox + vscode-jsonrpc RPC"
```

---

## Task 4: Update sandbox.ts and delete Firecracker files

- [ ] **Step 1: Update sandbox.ts**

Remove `import { resolveSnapshotPaths } from "./snapshot.ts"`, snapshot path variables, and Firecracker-specific options from the `createSandboxVm` call.

Update the `SandboxHandle` usage if the interface changed (the `conn` field replaces `request`).

- [ ] **Step 2: Delete all Firecracker files**

```bash
rm packages/aai-server/vsock.ts packages/aai-server/vsock.test.ts
rm packages/aai-server/firecracker.ts packages/aai-server/firecracker.test.ts
rm packages/aai-server/snapshot.ts
rm packages/aai-server/firecracker-integration.test.ts
rm packages/aai-server/vitest.firecracker.config.ts
rm packages/aai-server/guest/build-initrd.sh packages/aai-server/guest/build-kernel.sh
rm packages/aai-server/guest/kernel.config
rm packages/aai-server/guest/Dockerfile.firecracker
rm packages/aai-server/guest/docker-test.sh packages/aai-server/guest/debug-boot.sh
rm scripts/fc-debug-server.sh
```

- [ ] **Step 3: Rewrite fake-vm.ts and fake-vm-integration.test.ts**

Simplify `fake-vm.ts` to use jsonrpc:

```typescript
// packages/aai-server/guest/fake-vm.ts
import net from "node:net";
import fs from "node:fs";
import { main } from "./harness.ts";

const socketPath = process.argv[2];
if (!socketPath) { console.error("Usage: fake-vm.ts <socket-path>"); process.exit(1); }
try { fs.unlinkSync(socketPath); } catch {}

const server = net.createServer((conn) => {
  server.close();
  main(conn, conn).catch(() => process.exit(1));
});
server.listen(socketPath, () => console.log(`FAKE_VM_READY:${socketPath}`));
```

Update `fake-vm-integration.test.ts` to use jsonrpc calls (`conn.sendRequest("tool/execute", ...)`) instead of the old `channel.request({ type: "tool", ... })` protocol.

- [ ] **Step 4: Fix remaining imports**

Grep for `vsock`, `firecracker`, `snapshot.ts` across the codebase and fix all dangling references.

- [ ] **Step 5: Run typecheck + tests**

Run: `pnpm typecheck && pnpm vitest run --project aai-server`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(aai-server): delete Firecracker + vsock, update to jsonrpc"
```

---

## Task 5: Docker + gVisor integration tests

**Files:**
- Create: `packages/aai-server/guest/Dockerfile.gvisor`
- Create: `packages/aai-server/guest/docker-test.sh`
- Create: `packages/aai-server/gvisor-integration.test.ts`
- Create: `packages/aai-server/vitest.gvisor.config.ts`

- [ ] **Step 1: Create Dockerfile.gvisor**

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
    && curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor.gpg] https://storage.googleapis.com/gvisor/releases release main" \
       > /etc/apt/sources.list.d/gvisor.list \
    && apt-get update && apt-get install -y runsc \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/aai/package.json packages/aai/
COPY packages/aai-server/package.json packages/aai-server/
RUN pnpm install --frozen-lockfile --ignore-scripts --prod=false
COPY packages/aai/ packages/aai/
COPY packages/aai-server/ packages/aai-server/
COPY tsconfig.json vitest.shared.ts ./
RUN pnpm --filter @alexkroman1/aai build && pnpm --filter @alexkroman1/aai-server build
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
    && git init && git add -A && git commit -m "docker" --author="d <d@d>" --allow-empty 2>/dev/null || true
CMD ["pnpm", "vitest", "run", "--config", "packages/aai-server/vitest.gvisor.config.ts"]
```

- [ ] **Step 2: Create docker-test.sh, vitest.gvisor.config.ts**

- [ ] **Step 3: Create gvisor-integration.test.ts**

Tests using real `runsc` (skip if unavailable):
1. Bundle injection + tool execution
2. KV round-trip
3. Cross-agent isolation
4. Cannot read host filesystem
5. Cannot access network
6. Error propagation
7. Shutdown

Each test uses `createGvisorSandbox` + `createMessageConnection` over child stdio.

- [ ] **Step 4: Update vitest configs**

Exclude gvisor-integration.test.ts from unit tests, include in integration config.

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/guest/Dockerfile.gvisor \
       packages/aai-server/guest/docker-test.sh \
       packages/aai-server/gvisor-integration.test.ts \
       packages/aai-server/vitest.gvisor.config.ts
git commit -m "feat(aai-server): add gVisor Docker integration tests (no KVM needed)"
```

---

## Task 6: Update CI + CLAUDE.md + final verification

- [ ] **Step 1: Update check.yml**

Replace `docker-firecracker` with `docker-gvisor`. Use `--security-opt seccomp=unconfined`. Make it required (not informational).

- [ ] **Step 2: Update CLAUDE.md**

Replace all Firecracker references with gVisor. Update key files list. Update security architecture section.

- [ ] **Step 3: Run check:local**

Run: `pnpm check:local`

- [ ] **Step 4: Run Docker gVisor tests (Linux/CI)**

Run: `./packages/aai-server/guest/docker-test.sh`
Or: `./scripts/docker-test.sh pnpm check:local`

- [ ] **Step 5: Create changeset**

```bash
pnpm changeset:create --pkg @alexkroman1/aai-server --bump major \
  --summary "Replace Firecracker with gVisor sandbox + vscode-jsonrpc RPC (no KVM, works on Fly.io)"
```

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -m "chore(aai-server): gVisor sandbox migration complete"
```
