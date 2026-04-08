# LRU Slot Pool Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-reject slot cap with LRU eviction, add
pre-warming at deploy time, and add RSS admission guard.

**Architecture:** Swap `Map<string, AgentSlot>` for `LRUCache`
(already installed). LRU `dispose` callback shuts down evicted
sandboxes. New `warmAgent()` pre-boots at deploy time.
`process.memoryUsage().rss` check blocks spawns under memory
pressure. Inspired by workerd's prewarm/condemn pattern but
kept minimal — no lock hierarchy changes, no isolate-level
limit enforcer.

**Tech Stack:** lru-cache@11.3.2, process.memoryUsage()

---

### Task 1: Add MAX_RSS_MB constant

**Files:**

- Modify: `packages/aai-server/constants.ts`

- [ ] **Step 1: Add constant**

After MAX_SLOTS in constants.ts, add:

```typescript
/** Max RSS in MB before rejecting new sandbox spawns
 * (85% of 2048 MB). Env override: MAX_RSS_MB. */
export const MAX_RSS_MB =
  Number(process.env.MAX_RSS_MB) || 1740;
```

- [ ] **Step 2: Run tests, commit**

Run: `pnpm test:aai-server`

```bash
git add packages/aai-server/constants.ts
git commit -m "feat: add MAX_RSS_MB constant"
```

---

### Task 2: Replace Map with LRUCache

**Files:**

- Modify: `packages/aai-server/sandbox-slots.ts`
- Modify: `packages/aai-server/sandbox-slots.test.ts`
- Modify: `packages/aai-server/context.ts` (line 9)
- Modify: `packages/aai-server/index.ts` (lines 38, 66)
- Modify: `packages/aai-server/test-utils.ts`
- Modify: test files using `new Map<string, AgentSlot>()`

- [ ] **Step 1: Write failing test for LRU eviction**

In sandbox-slots.test.ts, add:

```typescript
it("evicts LRU slot at capacity", async () => {
  const { MAX_SLOTS } = await import("./constants.ts");
  const slots = createSlotCache();
  const first = makeMockSandbox();
  slots.set("agent-0", makeSlot({
    slug: "agent-0", sandbox: first,
  }));
  for (let i = 1; i < MAX_SLOTS; i++) {
    slots.set(`agent-${i}`, makeSlot({
      slug: `agent-${i}`, sandbox: makeMockSandbox(),
    }));
  }

  const extra = makeSlot({ slug: "new-agent" });
  slots.set(extra.slug, extra);
  const opts = makeEnsureOpts({ slug: "new-agent" });
  const result = await ensureAgent(extra, opts, slots);

  expect(result).toBeDefined();
  expect(slots.has("agent-0")).toBe(false);
  expect(first.shutdown).toHaveBeenCalled();
});
```

- [ ] **Step 2: Implement LRUCache swap**

In `sandbox-slots.ts`:

```typescript
import { LRUCache } from "lru-cache";

export type SlotCache =
  LRUCache<string, AgentSlot>;

export function createSlotCache(): SlotCache {
  return new LRUCache<string, AgentSlot>({
    max: MAX_SLOTS,
    dispose: (slot, _key, reason) => {
      if (reason === "set") return;
      if (!slot.sandbox) return;
      const sb = slot.sandbox;
      delete slot.sandbox;
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      delete slot.idleTimer;
      slot._idleAc?.abort();
      delete slot._idleAc;
      sb.shutdown().catch((err) => {
        console.warn("LRU eviction shutdown failed:",
          { slug: slot.slug, error: String(err) });
      });
    },
  });
}
```

Remove the `SlotCapacityError` throw from `ensureAgent`
(LRU handles capacity). Update all type signatures from
`Map<string, AgentSlot>` to `SlotCache`.

In `context.ts` line 9, change:

```typescript
slots: import("./sandbox-slots.ts").SlotCache;
```

In `index.ts`, replace both `new Map<string, AgentSlot>()`
with `createSlotCache()`.

In `test-utils.ts`, export `createSlotCache`. Update all
test files that create `new Map<string, AgentSlot>()`.

- [ ] **Step 3: Run tests, commit**

Run: `pnpm test:aai-server`

```bash
git add -A
git commit -m "feat: replace Map with LRUCache for slot eviction"
```

---

### Task 3: Add RSS admission guard

**Files:**

- Modify: `packages/aai-server/sandbox-slots.ts`
- Modify: `packages/aai-server/sandbox-slots.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("rejects spawn when RSS exceeds MAX_RSS_MB", async () => {
  const slot = makeSlot();
  const opts = makeEnsureOpts();
  const orig = process.memoryUsage;
  process.memoryUsage = Object.assign(
    () => ({ ...orig(), rss: 2000 * 1024 * 1024 }),
    orig,
  );
  try {
    await expect(ensureAgent(slot, opts))
      .rejects.toThrow("Memory pressure");
  } finally {
    process.memoryUsage = orig;
  }
});
```

- [ ] **Step 2: Implement**

Add in `sandbox-slots.ts`:

```typescript
import { MAX_RSS_MB } from "./constants.ts";

export class MemoryPressureError extends Error {
  constructor(rssMb: number, maxMb: number) {
    super(
      `Memory pressure: RSS ${rssMb.toFixed(0)}MB` +
      ` exceeds ${maxMb}MB`
    );
    this.name = "MemoryPressureError";
  }
}
```

In `ensureAgent`, before `spawnAgent`:

```typescript
const rssMb =
  process.memoryUsage().rss / (1024 * 1024);
if (rssMb > MAX_RSS_MB) {
  throw new MemoryPressureError(rssMb, MAX_RSS_MB);
}
```

- [ ] **Step 3: Run tests, commit**

Run: `pnpm test:aai-server`

```bash
git add packages/aai-server/sandbox-slots.ts \
  packages/aai-server/sandbox-slots.test.ts
git commit -m "feat: RSS admission guard in ensureAgent"
```

---

### Task 4: Add warmAgent for pre-warming

**Files:**

- Modify: `packages/aai-server/sandbox-slots.ts`
- Modify: `packages/aai-server/sandbox-slots.test.ts`
- Modify: `packages/aai-server/deploy.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe("warmAgent", () => {
  it("pre-boots sandbox for a slug", async () => {
    const { warmAgent } = await import(
      "./sandbox-slots.ts"
    );
    const slots = createSlotCache();
    const store = createTestStore();
    const storage = createTestStorage();
    await store.putAgent({
      slug: "warm-me",
      env: { ASSEMBLYAI_API_KEY: "key" },
      credential_hashes: ["hash"],
      worker: "w",
      clientFiles: {},
    });
    registerSlot(slots, {
      slug: "warm-me",
      env: {},
      credential_hashes: ["hash"],
    });

    await warmAgent("warm-me", {
      slots, store, storage,
      createSandbox: mockCreateSandbox,
    });

    expect(mockCreateSandbox).toHaveBeenCalledOnce();
    expect(slots.get("warm-me")?.sandbox)
      .toBeDefined();
  });
});
```

- [ ] **Step 2: Implement warmAgent**

In `sandbox-slots.ts`:

```typescript
export async function warmAgent(
  slug: string,
  opts: {
    createSandbox: (o: SandboxOptions) => Promise<Sandbox>;
    slots: SlotCache;
    store: BundleStore;
    storage: Storage;
  },
): Promise<void> {
  try {
    await resolveSandbox(slug, opts);
  } catch (err) {
    console.warn("Warm-up failed:", {
      slug, error: String(err),
    });
  }
}
```

- [ ] **Step 3: Wire into deploy handler**

In `deploy.ts`, after `slots.set(slug, ...)`, add:

```typescript
// Fire-and-forget pre-warm
void warmAgent(slug, {
  createSandbox: (await import("./sandbox.ts"))
    .createSandbox,
  slots: c.env.slots,
  store: c.env.store,
  storage: c.env.storage,
});
```

- [ ] **Step 4: Run tests, commit**

Run: `pnpm test:aai-server`

```bash
git add -A
git commit -m "feat: warmAgent pre-boots sandbox at deploy"
```

---

### Task 5: Validate

- [ ] **Step 1:** `pnpm test:aai-server`
- [ ] **Step 2:** `pnpm check:local`
- [ ] **Step 3:** `pnpm vitest run --config vitest.adversarial.config.ts`
