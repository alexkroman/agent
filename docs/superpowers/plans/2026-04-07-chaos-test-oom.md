# OOM Chaos Testing & Server Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resource limits (WebSocket connections, sandbox slots) to aai-server and a chaos test suite that validates the server survives resource exhaustion without OOM kills.

**Architecture:** Server hardening adds connection counting in the WebSocket upgrade handler and a slot cap in `ensureAgent()`. Chaos tests use testcontainers to run the real Docker container with memory limits and stress it with connection floods, sandbox storms, and load/unload cycles. All new code lives in `packages/aai-server/`.

**Tech Stack:** Vitest, testcontainers, ws (existing), Docker Compose

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/aai-server/constants.ts` | Modify | Add `MAX_CONNECTIONS`, `MAX_SLOTS` constants |
| `packages/aai-server/sandbox-slots.ts` | Modify | Add `SlotCapacityError`, slot cap check in `ensureAgent`, env-configurable idle timeout |
| `packages/aai-server/sandbox-slots.test.ts` | Modify | Add unit tests for slot cap |
| `packages/aai-server/orchestrator.ts` | Modify | Add connection counter, reject at cap, catch `SlotCapacityError` |
| `packages/aai-server/orchestrator.test.ts` | Modify | Add unit tests for connection limit |
| `docker-compose.yml` | Create | Compose file with server + MinIO + memory limits |
| `packages/aai-server/chaos/vitest.chaos.config.ts` | Create | Vitest config for chaos tier |
| `packages/aai-server/chaos/setup.ts` | Create | testcontainers compose lifecycle + deploy helper |
| `packages/aai-server/chaos/helpers.ts` | Create | WS flood, memory sampler utilities |
| `packages/aai-server/chaos/connection-flood.test.ts` | Create | Test 1: WebSocket connection flood |
| `packages/aai-server/chaos/sandbox-storm.test.ts` | Create | Test 2: Concurrent sandbox spawn storm |
| `packages/aai-server/chaos/leak-cycle.test.ts` | Create | Test 3: Sustained load + idle eviction |
| `package.json` (root) | Modify | Add `docker:up`, `docker:down`, `test:chaos` scripts |
| `packages/aai-server/package.json` | Modify | Add testcontainers dev dependency, `test:chaos` script |

---

### Task 1: Add Resource Limit Constants

**Files:**
- Modify: `packages/aai-server/constants.ts:17-20`

- [ ] **Step 1: Add MAX_CONNECTIONS and MAX_SLOTS constants**

In `packages/aai-server/constants.ts`, add after the `DEFAULT_SLOT_IDLE_MS` line (line 20):

```ts
/** Max concurrent WebSocket connections before the server rejects new upgrades. */
export const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 100;

/** Max active sandbox slots before the server rejects new sandbox spawns. */
export const MAX_SLOTS = Number(process.env.MAX_SLOTS) || 10;
```

- [ ] **Step 2: Make idle timeout env-configurable**

In `packages/aai-server/constants.ts`, change line 20 from:

```ts
export const DEFAULT_SLOT_IDLE_MS = 5 * 60 * 1000;
```

to:

```ts
export const DEFAULT_SLOT_IDLE_MS = Number(process.env.SLOT_IDLE_MS) || 5 * 60 * 1000;
```

- [ ] **Step 3: Verify typecheck passes**

Run: `cd .worktrees/chaos-test && pnpm --filter @alexkroman1/aai-server typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/aai-server/constants.ts
git commit -m "feat(server): add MAX_CONNECTIONS, MAX_SLOTS, and env-configurable idle timeout"
```

---

### Task 2: Add Slot Cap to sandbox-slots.ts (TDD)

**Files:**
- Modify: `packages/aai-server/sandbox-slots.ts:1-5, 108-127`
- Modify: `packages/aai-server/sandbox-slots.test.ts`

- [ ] **Step 1: Write failing test for slot cap**

In `packages/aai-server/sandbox-slots.test.ts`, add this test inside the `describe("ensureAgent")` block, after the existing tests (after line 193):

```ts
  it("throws SlotCapacityError when active slots exceed MAX_SLOTS", async () => {
    const { SlotCapacityError } = await import("./sandbox-slots.ts");
    const { MAX_SLOTS } = await import("./constants.ts");

    // Create MAX_SLOTS slots that all have active sandboxes
    const slots = new Map<string, AgentSlot>();
    for (let i = 0; i < MAX_SLOTS; i++) {
      const s = makeSlot({ slug: `agent-${i}`, sandbox: makeMockSandbox() });
      slots.set(s.slug, s);
    }

    // Try to spawn one more
    const extraSlot = makeSlot({ slug: "one-too-many" });
    slots.set(extraSlot.slug, extraSlot);
    const opts = makeEnsureOpts({ slug: "one-too-many" });

    await expect(ensureAgent(extraSlot, opts, slots)).rejects.toThrow(SlotCapacityError);
    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });

  it("allows spawn when active slots are below MAX_SLOTS", async () => {
    const slots = new Map<string, AgentSlot>();
    const slot = makeSlot({ slug: "ok-agent" });
    slots.set(slot.slug, slot);
    const opts = makeEnsureOpts({ slug: "ok-agent" });

    const result = await ensureAgent(slot, opts, slots);
    expect(result).toBeDefined();
    expect(mockCreateSandbox).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .worktrees/chaos-test && pnpm vitest run packages/aai-server/sandbox-slots.test.ts`
Expected: FAIL — `SlotCapacityError` not exported, `ensureAgent` doesn't accept `slots` parameter.

- [ ] **Step 3: Implement slot cap**

In `packages/aai-server/sandbox-slots.ts`:

First, add the error class after the imports (after line 22):

```ts
/** Thrown when the active sandbox slot count has reached MAX_SLOTS. */
export class SlotCapacityError extends Error {
  constructor(activeCount: number, max: number) {
    super(`Slot capacity reached: ${activeCount}/${max} active slots`);
    this.name = "SlotCapacityError";
  }
}
```

Then add the import for MAX_SLOTS at line 20 (update the existing import):

```ts
import { DEFAULT_SLOT_IDLE_MS, MAX_SLOTS } from "./constants.ts";
```

Then modify `ensureAgent` (currently line 108) to accept an optional `slots` map and check the cap:

```ts
export async function ensureAgent(
  slot: AgentSlot,
  opts: EnsureOpts,
  slots?: Map<string, AgentSlot>,
): Promise<Sandbox> {
  const release = await slotLock(slot.slug);
  try {
    if (slot.sandbox) {
      resetIdleTimer(slot);
      return slot.sandbox;
    }

    // Check slot cap before spawning a new sandbox
    if (slots) {
      const activeCount = [...slots.values()].filter((s) => s.sandbox).length;
      if (activeCount >= MAX_SLOTS) {
        throw new SlotCapacityError(activeCount, MAX_SLOTS);
      }
    }

    const t0 = performance.now();
    const sandbox = await spawnAgent(slot, opts);
    resetIdleTimer(slot);
    console.info("Agent sandbox ready", {
      slug: slot.slug,
      durationMs: Math.round(performance.now() - t0),
    });
    return sandbox;
  } finally {
    release();
  }
}
```

Then update `resolveSandbox` (currently line 161) to pass `slots` through to `ensureAgent`. Change line 183:

```ts
  return await ensureAgent(slot, {
```

to:

```ts
  return await ensureAgent(slot, {
```

and at the closing of ensureAgent call (after `getAgentEnv`), add the slots parameter:

```ts
  return await ensureAgent(
    slot,
    {
      createSandbox: opts.createSandbox,
      getWorkerCode: (s: string) => opts.store.getWorkerCode(s),
      storage: opts.storage,
      slug,
      getApiKey: async () => {
        const env = await envPromise;
        return env?.ASSEMBLYAI_API_KEY ?? "";
      },
      getAgentEnv: async () => {
        const env = await envPromise;
        if (!env) return {};
        const { ASSEMBLYAI_API_KEY: _, ...agentEnv } = env;
        return agentEnv;
      },
    },
    opts.slots,
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd .worktrees/chaos-test && pnpm vitest run packages/aai-server/sandbox-slots.test.ts`
Expected: All tests PASS including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/sandbox-slots.ts packages/aai-server/sandbox-slots.test.ts
git commit -m "feat(server): add slot cap with SlotCapacityError in ensureAgent"
```

---

### Task 3: Add WebSocket Connection Limit to Orchestrator (TDD)

**Files:**
- Modify: `packages/aai-server/orchestrator.ts:148-187`
- Modify: `packages/aai-server/orchestrator.test.ts`

- [ ] **Step 1: Read orchestrator.test.ts to understand existing test patterns**

Run: `cat packages/aai-server/orchestrator.test.ts | head -60`
Look at how tests set up the orchestrator and make requests. Use the same `createTestOrchestrator` pattern.

- [ ] **Step 2: Write failing test for connection limit**

The WebSocket upgrade handler operates at the Node HTTP level, not through Hono's `app.request()`. Unit testing the upgrade path requires a real HTTP server. Instead, we'll test the connection tracking logic as an exported utility and validate the full behavior in chaos tests.

Add a new file `packages/aai-server/connection-tracker.ts`:

First, write the test file `packages/aai-server/connection-tracker.test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { createConnectionTracker } from "./connection-tracker.ts";

describe("createConnectionTracker", () => {
  it("allows connections under the limit", () => {
    const tracker = createConnectionTracker(3);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.count).toBe(3);
  });

  it("rejects connections at the limit", () => {
    const tracker = createConnectionTracker(2);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(false);
    expect(tracker.count).toBe(2);
  });

  it("allows new connections after release", () => {
    const tracker = createConnectionTracker(1);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(false);
    tracker.release();
    expect(tracker.count).toBe(0);
    expect(tracker.tryAcquire()).toBe(true);
  });

  it("never goes below zero", () => {
    const tracker = createConnectionTracker(5);
    tracker.release();
    expect(tracker.count).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd .worktrees/chaos-test && pnpm vitest run packages/aai-server/connection-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement connection tracker**

Create `packages/aai-server/connection-tracker.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.

export type ConnectionTracker = {
  /** Try to acquire a connection slot. Returns false if at capacity. */
  tryAcquire(): boolean;
  /** Release a connection slot. */
  release(): void;
  /** Current active connection count. */
  readonly count: number;
};

export function createConnectionTracker(max: number): ConnectionTracker {
  let count = 0;
  return {
    tryAcquire() {
      if (count >= max) return false;
      count++;
      return true;
    },
    release() {
      if (count > 0) count--;
    },
    get count() {
      return count;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd .worktrees/chaos-test && pnpm vitest run packages/aai-server/connection-tracker.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 6: Wire connection tracker into orchestrator**

In `packages/aai-server/orchestrator.ts`, add the import after line 6:

```ts
import { createConnectionTracker } from "./connection-tracker.ts";
import { MAX_CONNECTIONS } from "./constants.ts";
```

Then, inside `createOrchestrator`, add the tracker before the WSS creation (before line 150):

```ts
  const connections = createConnectionTracker(MAX_CONNECTIONS);
```

Then modify the upgrade handler (lines 153-186) to check the tracker. Replace the `server.on("upgrade", ...)` callback:

```ts
    server.on("upgrade", async (req, socket, head) => {
      const pathOnly = req.url?.split("?")[0] ?? "";
      if (!/^\/[a-z0-9][a-z0-9_-]*[a-z0-9]\/websocket$/.test(pathOnly)) return;

      if (!connections.tryAcquire()) {
        console.warn("WebSocket connection limit reached, rejecting upgrade");
        socket.destroy();
        return;
      }

      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = url.pathname.match(/^\/([a-z0-9][a-z0-9_-]*[a-z0-9])\/websocket$/);
        if (!match) {
          connections.release();
          socket.destroy();
          return;
        }
        const slug = validateSlug(match[1] as string);
        const sandbox = await resolveSandbox(slug, {
          slots: opts.slots,
          store: opts.store,
          storage: opts.storage,
        });
        if (!sandbox) {
          connections.release();
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.on("close", () => connections.release());
          const resumeFrom = url.searchParams.get("sessionId") ?? undefined;
          const skipGreeting = url.searchParams.has("resume") || resumeFrom !== undefined;
          sandbox.startSession(ws as unknown as SessionWebSocket, {
            skipGreeting,
            ...(resumeFrom ? { resumeFrom } : {}),
          });
        });
      } catch (err: unknown) {
        connections.release();
        console.error("WebSocket open error:", err);
        socket.destroy();
      }
    });
```

- [ ] **Step 7: Run existing tests to verify nothing is broken**

Run: `cd .worktrees/chaos-test && pnpm vitest run --project aai-server`
Expected: All existing tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/aai-server/connection-tracker.ts packages/aai-server/connection-tracker.test.ts packages/aai-server/orchestrator.ts
git commit -m "feat(server): add WebSocket connection limit via ConnectionTracker"
```

---

### Task 4: Add Docker Compose and Scripts

**Files:**
- Create: `docker-compose.yml` (repo root)
- Modify: `package.json` (root)
- Modify: `packages/aai-server/package.json`

- [ ] **Step 1: Create docker-compose.yml at repo root**

Create `docker-compose.yml`:

```yaml
services:
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio-init:
    image: minio/mc
    depends_on:
      minio:
        condition: service_healthy
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin &&
      mc mb local/aai-agents --ignore-existing &&
      echo 'Bucket aai-agents ready'
      "

  server:
    build:
      context: .
      dockerfile: packages/aai-server/Dockerfile
    ports:
      - "8080:8080"
    depends_on:
      minio-init:
        condition: service_completed_successfully
    environment:
      PORT: "8080"
      BUCKET_NAME: aai-agents
      AWS_ENDPOINT_URL_S3: http://minio:9000
      AWS_ACCESS_KEY_ID: minioadmin
      AWS_SECRET_ACCESS_KEY: minioadmin
      KV_SCOPE_SECRET: docker-dev-secret
      MAX_CONNECTIONS: "50"
      MAX_SLOTS: "5"
      SLOT_IDLE_MS: "10000"
    mem_limit: 512m
    memswap_limit: 512m

volumes:
  minio-data:
```

- [ ] **Step 2: Add scripts to root package.json**

In `package.json` (root), add to the `scripts` object:

```json
"docker:up": "docker compose up --build",
"docker:down": "docker compose down -v",
"test:chaos": "pnpm --filter @alexkroman1/aai-server test:chaos"
```

- [ ] **Step 3: Add test:chaos script to aai-server package.json**

In `packages/aai-server/package.json`, add to the `scripts` object:

```json
"test:chaos": "vitest run --config chaos/vitest.chaos.config.ts"
```

- [ ] **Step 4: Install testcontainers**

Run: `cd .worktrees/chaos-test && pnpm --filter @alexkroman1/aai-server add -D testcontainers`

- [ ] **Step 5: Verify docker compose builds**

Run: `cd .worktrees/chaos-test && docker compose build`
Expected: Image builds successfully.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml package.json packages/aai-server/package.json pnpm-lock.yaml
git commit -m "feat: add docker-compose.yml, testcontainers dep, and chaos test scripts"
```

---

### Task 5: Create Chaos Test Infrastructure

**Files:**
- Create: `packages/aai-server/chaos/vitest.chaos.config.ts`
- Create: `packages/aai-server/chaos/setup.ts`
- Create: `packages/aai-server/chaos/helpers.ts`

- [ ] **Step 1: Create Vitest config for chaos tier**

Create `packages/aai-server/chaos/vitest.chaos.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/aai-server/chaos/*.test.ts"],
    testTimeout: 300_000, // 5 minutes per test
    hookTimeout: 180_000, // 3 minutes for setup/teardown
    pool: "forks",
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
});
```

- [ ] **Step 2: Create testcontainers setup module**

Create `packages/aai-server/chaos/setup.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Testcontainers setup for chaos tests.
 * Starts the server + MinIO compose stack and deploys a minimal test agent.
 */

import path from "node:path";
import { DockerComposeEnvironment, Wait } from "testcontainers";

export type ChaosEnv = {
  serverUrl: string;
  wsUrl: string;
  containerId: string;
  stop: () => Promise<void>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DEPLOY_KEY = "chaos-test-key";

export { DEPLOY_KEY };

export async function startChaosEnv(
  envOverrides: Record<string, string> = {},
): Promise<ChaosEnv> {
  const environment = await new DockerComposeEnvironment(REPO_ROOT, "docker-compose.yml")
    .withEnvironment(envOverrides)
    .withBuild()
    .withWaitStrategy("server-1", Wait.forHttp("/health", 8080).forStatusCode(200))
    .up();

  const serverContainer = environment.getContainer("server-1");
  const host = serverContainer.getHost();
  const port = serverContainer.getMappedPort(8080);
  const containerId = serverContainer.getId();

  const serverUrl = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}`;

  return {
    serverUrl,
    wsUrl,
    containerId,
    stop: () => environment.down({ removeVolumes: true }),
  };
}

export async function deployTestAgent(
  serverUrl: string,
  slug: string,
  key = DEPLOY_KEY,
): Promise<void> {
  const res = await fetch(`${serverUrl}/${slug}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      env: { ASSEMBLYAI_API_KEY: "fake-key" },
      worker: `
        export default {
          async fetch(request) {
            return new Response("ok");
          }
        };
      `,
      clientFiles: {
        "index.html": "<!DOCTYPE html><html><body>test</body></html>",
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deploy failed (${res.status}): ${body}`);
  }
}
```

- [ ] **Step 3: Create test helper utilities**

Create `packages/aai-server/chaos/helpers.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos test helpers: WebSocket flooding, memory sampling, health checking.
 */

import { execFileSync } from "node:child_process";
import WebSocket from "ws";

export type MemorySample = {
  timestampMs: number;
  usageBytes: number;
  limitBytes: number;
  percent: number;
};

/**
 * Sample container memory usage via `docker stats --no-stream`.
 * Returns current memory usage and limit.
 */
export function sampleMemory(containerId: string): MemorySample {
  const output = execFileSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", containerId],
    { encoding: "utf-8", timeout: 10_000 },
  );
  const stats = JSON.parse(output.trim());

  // Parse "123.4MiB / 512MiB" format from MemUsage
  const memUsage: string = stats.MemUsage;
  const [usageStr, limitStr] = memUsage.split(" / ");
  const usageBytes = parseMemValue(usageStr);
  const limitBytes = parseMemValue(limitStr);

  return {
    timestampMs: Date.now(),
    usageBytes,
    limitBytes,
    percent: (usageBytes / limitBytes) * 100,
  };
}

function parseMemValue(str: string): number {
  const trimmed = str.trim();
  const num = Number.parseFloat(trimmed);
  if (trimmed.endsWith("GiB")) return num * 1024 * 1024 * 1024;
  if (trimmed.endsWith("MiB")) return num * 1024 * 1024;
  if (trimmed.endsWith("KiB")) return num * 1024;
  if (trimmed.endsWith("B")) return num;
  return num;
}

/**
 * Open N WebSocket connections to the given URL.
 * Returns an array of open connections and an array of connections that failed to open.
 */
export async function openConnections(
  wsUrl: string,
  slug: string,
  count: number,
  timeoutMs = 5_000,
): Promise<{ opened: WebSocket[]; rejected: number }> {
  const results = await Promise.allSettled(
    Array.from({ length: count }, () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`${wsUrl}/${slug}/websocket`);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error("Connection timeout"));
        }, timeoutMs);
        ws.on("open", () => {
          clearTimeout(timer);
          resolve(ws);
        });
        ws.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        ws.on("unexpected-response", () => {
          clearTimeout(timer);
          reject(new Error("Unexpected response"));
        });
      }),
    ),
  );

  const opened: WebSocket[] = [];
  let rejected = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      opened.push(r.value);
    } else {
      rejected++;
    }
  }
  return { opened, rejected };
}

/** Close all WebSocket connections. */
export async function closeAll(connections: WebSocket[]): Promise<void> {
  await Promise.allSettled(
    connections.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.on("close", () => resolve());
          ws.close();
        }),
    ),
  );
}

/** Check that the health endpoint responds with 200. */
export async function checkHealth(serverUrl: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sample memory every intervalMs for durationMs.
 * Returns all samples collected.
 */
export async function monitorMemory(
  containerId: string,
  durationMs: number,
  intervalMs = 1_000,
): Promise<MemorySample[]> {
  const samples: MemorySample[] = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    try {
      samples.push(sampleMemory(containerId));
    } catch {
      // docker stats can occasionally fail; skip sample
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return samples;
}

/** Wait for a condition to be true, polling at intervalMs. */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
```

- [ ] **Step 4: Verify files have no syntax errors**

Run: `cd .worktrees/chaos-test && pnpm --filter @alexkroman1/aai-server typecheck`
Expected: No errors (new files are .ts, will be picked up by tsconfig).

- [ ] **Step 5: Commit**

```bash
git add packages/aai-server/chaos/
git commit -m "feat(server): add chaos test infrastructure (vitest config, setup, helpers)"
```

---

### Task 6: Chaos Test 1 — WebSocket Connection Flood

**Files:**
- Create: `packages/aai-server/chaos/connection-flood.test.ts`

- [ ] **Step 1: Write the connection flood test**

Create `packages/aai-server/chaos/connection-flood.test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos Test 1: WebSocket Connection Flood
 *
 * Verifies the server rejects connections before OOM.
 * Opens connections in batches, monitors memory, asserts the server
 * stays healthy and rejects excess connections gracefully.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { type ChaosEnv, DEPLOY_KEY, deployTestAgent, startChaosEnv } from "./setup.ts";

let env: ChaosEnv;
const SLUG = "flood-test";

beforeAll(async () => {
  env = await startChaosEnv();
  await deployTestAgent(env.serverUrl, SLUG, DEPLOY_KEY);
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("connection flood", () => {
  test("server rejects connections before OOM and stays healthy", async () => {
    const allConnections: import("ws").default[] = [];
    const BATCH_SIZE = 10;
    const MAX_BATCHES = 10; // Up to 100 connections (MAX_CONNECTIONS is 50 in compose)
    let rejectedTotal = 0;

    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const { opened, rejected } = await openConnections(
          env.wsUrl,
          SLUG,
          BATCH_SIZE,
        );
        allConnections.push(...opened);
        rejectedTotal += rejected;

        // Check memory isn't approaching limit
        const mem = sampleMemory(env.containerId);
        console.log(
          `Batch ${batch + 1}: ${allConnections.length} open, ${rejectedTotal} rejected, ` +
            `memory ${mem.percent.toFixed(1)}%`,
        );

        // If we're seeing rejections, the limit is working
        if (rejected > 0) break;

        // Fail early if memory is dangerously high
        expect(mem.percent).toBeLessThan(90);
      }

      // We should have seen some rejections (MAX_CONNECTIONS=50 in compose)
      expect(rejectedTotal).toBeGreaterThan(0);

      // Health endpoint should still respond
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);

      // Existing connections should still be alive
      const aliveCount = allConnections.filter(
        (ws) => ws.readyState === ws.OPEN,
      ).length;
      expect(aliveCount).toBeGreaterThan(0);

      // Memory should have stabilized (not still growing)
      const mem1 = sampleMemory(env.containerId);
      await new Promise((r) => setTimeout(r, 2_000));
      const mem2 = sampleMemory(env.containerId);
      const growth = mem2.usageBytes - mem1.usageBytes;
      const growthMB = growth / (1024 * 1024);
      console.log(`Memory growth after stabilization: ${growthMB.toFixed(1)}MB`);
      expect(growthMB).toBeLessThan(20); // Less than 20MB growth = stabilized
    } finally {
      await closeAll(allConnections);
    }
  });
});
```

- [ ] **Step 2: Run the test against the Docker container**

Run: `cd .worktrees/chaos-test && pnpm test:chaos -- connection-flood`
Expected: PASS — server rejects connections at the 50-connection limit, health stays responsive, memory stabilizes.

If the test fails because testcontainers can't find the compose service name, check the container name format and adjust `setup.ts` accordingly.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/chaos/connection-flood.test.ts
git commit -m "test(server): add chaos test for WebSocket connection flood"
```

---

### Task 7: Chaos Test 2 — Sandbox Spawn Storm

**Files:**
- Create: `packages/aai-server/chaos/sandbox-storm.test.ts`

- [ ] **Step 1: Write the sandbox storm test**

Create `packages/aai-server/chaos/sandbox-storm.test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos Test 2: Concurrent Sandbox Spawn Storm
 *
 * Deploys many agents with different slugs and opens connections to each.
 * Verifies the server caps sandbox spawns with back-pressure (503/destroy)
 * and existing sessions continue working.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkHealth, closeAll, openConnections, sampleMemory } from "./helpers.ts";
import { type ChaosEnv, DEPLOY_KEY, deployTestAgent, startChaosEnv } from "./setup.ts";

let env: ChaosEnv;

beforeAll(async () => {
  env = await startChaosEnv();
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("sandbox spawn storm", () => {
  test("server caps slot count and rejects excess spawns", async () => {
    const MAX_AGENTS = 8; // MAX_SLOTS is 5 in compose
    const allConnections: import("ws").default[] = [];
    const deployedSlugs: string[] = [];
    let rejectedCount = 0;

    try {
      // Deploy agents
      for (let i = 0; i < MAX_AGENTS; i++) {
        const slug = `storm-agent-${i}`;
        try {
          await deployTestAgent(env.serverUrl, slug, DEPLOY_KEY);
          deployedSlugs.push(slug);
        } catch {
          // Deploy might fail if server is under pressure — that's ok
        }
      }

      // Open one connection to each agent (triggers sandbox spawn)
      for (const slug of deployedSlugs) {
        const { opened, rejected } = await openConnections(env.wsUrl, slug, 1, 15_000);
        allConnections.push(...opened);
        rejectedCount += rejected;

        const mem = sampleMemory(env.containerId);
        console.log(
          `Agent ${slug}: ${opened.length ? "connected" : "rejected"}, ` +
            `memory ${mem.percent.toFixed(1)}%`,
        );

        // Fail early on dangerous memory usage
        expect(mem.percent).toBeLessThan(90);
      }

      // Some connections should have been rejected (MAX_SLOTS=5)
      expect(rejectedCount).toBeGreaterThan(0);

      // Health should still be responsive
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);

      // At least some connections should be working
      const aliveCount = allConnections.filter(
        (ws) => ws.readyState === ws.OPEN,
      ).length;
      expect(aliveCount).toBeGreaterThan(0);
      expect(aliveCount).toBeLessThanOrEqual(5); // MAX_SLOTS

      console.log(`Result: ${aliveCount} active, ${rejectedCount} rejected`);
    } finally {
      await closeAll(allConnections);
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd .worktrees/chaos-test && pnpm test:chaos -- sandbox-storm`
Expected: PASS — at most 5 sandboxes spawn, excess are rejected, health stays up.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/chaos/sandbox-storm.test.ts
git commit -m "test(server): add chaos test for sandbox spawn storm"
```

---

### Task 8: Chaos Test 3 — Leak Cycle Detection

**Files:**
- Create: `packages/aai-server/chaos/leak-cycle.test.ts`

- [ ] **Step 1: Write the leak cycle test**

Create `packages/aai-server/chaos/leak-cycle.test.ts`:

```ts
// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos Test 3: Sustained Load + Idle Eviction (Leak Detection)
 *
 * Opens connections, sustains load, lets idle eviction clean up,
 * then verifies memory returns to baseline. Repeats multiple cycles
 * to detect monotonic memory ratcheting (leaks).
 *
 * SLOT_IDLE_MS is set to 10s in docker-compose.yml for fast eviction.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  checkHealth,
  closeAll,
  openConnections,
  sampleMemory,
  waitFor,
} from "./helpers.ts";
import { type ChaosEnv, DEPLOY_KEY, deployTestAgent, startChaosEnv } from "./setup.ts";

let env: ChaosEnv;

beforeAll(async () => {
  env = await startChaosEnv();
}, 180_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

describe("leak cycle detection", () => {
  test("memory returns to baseline after load/unload cycles", async () => {
    const SLUG = "leak-test";
    await deployTestAgent(env.serverUrl, SLUG, DEPLOY_KEY);

    // Wait for server to settle, then record baseline
    await new Promise((r) => setTimeout(r, 3_000));
    const baseline = sampleMemory(env.containerId);
    console.log(`Baseline memory: ${(baseline.usageBytes / 1024 / 1024).toFixed(1)}MB`);

    const CYCLES = 3;
    const CONNECTIONS_PER_CYCLE = 20;
    const postEvictionMemory: number[] = [];

    for (let cycle = 0; cycle < CYCLES; cycle++) {
      console.log(`\n--- Cycle ${cycle + 1}/${CYCLES} ---`);

      // Open connections (sustain load)
      const { opened } = await openConnections(
        env.wsUrl,
        SLUG,
        CONNECTIONS_PER_CYCLE,
        10_000,
      );
      console.log(`Opened ${opened.length} connections`);

      const loadMem = sampleMemory(env.containerId);
      console.log(`Under load: ${(loadMem.usageBytes / 1024 / 1024).toFixed(1)}MB`);

      // Hold load for a few seconds
      await new Promise((r) => setTimeout(r, 5_000));

      // Close all connections
      await closeAll(opened);
      console.log("All connections closed");

      // Wait for idle eviction (SLOT_IDLE_MS=10s + buffer)
      await new Promise((r) => setTimeout(r, 15_000));

      // Wait for GC to settle
      await new Promise((r) => setTimeout(r, 5_000));

      const postMem = sampleMemory(env.containerId);
      postEvictionMemory.push(postMem.usageBytes);
      console.log(
        `Post-eviction: ${(postMem.usageBytes / 1024 / 1024).toFixed(1)}MB ` +
          `(${((postMem.usageBytes / baseline.usageBytes - 1) * 100).toFixed(1)}% above baseline)`,
      );

      // Memory should be within 20% of baseline after eviction
      expect(postMem.usageBytes).toBeLessThan(baseline.usageBytes * 1.2);

      // Health check
      const healthy = await checkHealth(env.serverUrl);
      expect(healthy).toBe(true);
    }

    // Check for monotonic increase (leak detection)
    // Each post-eviction sample should not be consistently higher than the previous
    let increasing = 0;
    for (let i = 1; i < postEvictionMemory.length; i++) {
      if (postEvictionMemory[i]! > postEvictionMemory[i - 1]!) {
        increasing++;
      }
    }
    // If ALL cycles show increasing memory, likely a leak
    expect(increasing).toBeLessThan(CYCLES - 1);

    console.log("\nLeak cycle test complete — no monotonic memory increase detected");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd .worktrees/chaos-test && pnpm test:chaos -- leak-cycle`
Expected: PASS — memory returns to within 20% of baseline after each cycle, no monotonic increase.

- [ ] **Step 3: Commit**

```bash
git add packages/aai-server/chaos/leak-cycle.test.ts
git commit -m "test(server): add chaos test for memory leak cycle detection"
```

---

### Task 9: Run Full Chaos Suite and Verify

**Files:** None (validation only)

- [ ] **Step 1: Run the complete chaos test suite**

Run: `cd .worktrees/chaos-test && pnpm test:chaos`
Expected: All 3 test files pass:
- `connection-flood.test.ts` — connections rejected at limit, server healthy
- `sandbox-storm.test.ts` — slot cap enforced, excess rejected
- `leak-cycle.test.ts` — memory returns to baseline across cycles

- [ ] **Step 2: Run existing tests to ensure no regressions**

Run: `cd .worktrees/chaos-test && pnpm vitest run --project aai-server`
Expected: All existing unit tests pass. The hardening changes (connection tracker, slot cap) don't break existing behavior because:
- `ensureAgent` slots parameter is optional (defaults to undefined = no cap check)
- Connection tracker is only wired into the upgrade handler
- Constants are backward-compatible (env vars default to previous behavior)

- [ ] **Step 3: Run typecheck**

Run: `cd .worktrees/chaos-test && pnpm typecheck`
Expected: No type errors across the workspace.

- [ ] **Step 4: Run lint**

Run: `cd .worktrees/chaos-test && pnpm lint`
Expected: No lint errors. If Biome flags new files, fix with `pnpm lint:fix`.

- [ ] **Step 5: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: address lint/type issues from chaos test integration"
```
