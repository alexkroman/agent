// Copyright 2025 the AAI authors. MIT license.
import { createStorage } from "unstorage";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { ByteBudgetTtlCache, blobKey, contentHash, createBundleStore } from "./bundle-store.ts";
import { MAX_ENV_SIZE } from "./constants.ts";
import { createMemorySecretStore } from "./secret-store.ts";
import { TEST_AGENT_CONFIG } from "./test-utils.ts";

function makeStore(secrets = createMemorySecretStore()) {
  const storage = createStorage();
  const store = createBundleStore(storage, { secrets, agents: createMemoryAgentRows() });
  return { storage, store, secrets };
}

const BASE_BUNDLE = {
  slug: "test-agent",
  env: {},
  worker: "console.log('w');",
  clientFiles: {},
  credential_hashes: ["hash1"],
  agentConfig: TEST_AGENT_CONFIG,
};

describe("bundle store (agents rows + content-addressed blobs)", () => {
  test("putAgent + getAgent round-trip", async () => {
    const { store } = makeStore();

    await store.putAgent({
      ...BASE_BUNDLE,
      env: { ASSEMBLYAI_API_KEY: "key123" },
      clientFiles: { "index.html": "<html></html>" },
    });

    const record = await store.getAgent("test-agent");
    expect(record).not.toBeNull();
    expect(record?.slug).toBe("test-agent");
    expect(record?.credential_hashes).toEqual(["hash1"]);
    expect(record?.version).toBe(1);
    expect(record?.worker_hash).toBe(contentHash("console.log('w');"));
    expect(record?.client_files).toEqual({ "index.html": contentHash("<html></html>") });
  });

  test("getAgent returns null for non-existent agent", async () => {
    const { store } = makeStore();
    expect(await store.getAgent("nonexistent")).toBeNull();
  });

  test("blobs are stored under their content hash", async () => {
    const { store, storage } = makeStore();

    await store.putAgent({ ...BASE_BUNDLE, clientFiles: { "index.html": "<html></html>" } });

    expect(await storage.getItem(blobKey(contentHash("console.log('w');")))).toBe(
      "console.log('w');",
    );
    expect(await storage.getItem(blobKey(contentHash("<html></html>")))).toBe("<html></html>");
  });

  test("redeploy bumps the version and repoints the row", async () => {
    const { store } = makeStore();

    await store.putAgent({ ...BASE_BUNDLE, worker: "v1" });
    expect(await store.getAgentVersion("test-agent")).toBe(1);

    await store.putAgent({ ...BASE_BUNDLE, worker: "v2" });
    expect(await store.getAgentVersion("test-agent")).toBe(2);
    expect(await store.getWorkerCode("test-agent")).toBe("v2");
  });

  test("getAgentVersion returns null after delete", async () => {
    const { store } = makeStore();
    await store.putAgent(BASE_BUNDLE);
    expect(await store.getAgentVersion("test-agent")).toBe(1);

    await store.deleteAgent("test-agent");
    expect(await store.getAgentVersion("test-agent")).toBeNull();
  });

  test("env writes over MAX_ENV_SIZE are rejected on both write paths", async () => {
    const { store } = makeStore();
    const oversized = { BIG: "x".repeat(MAX_ENV_SIZE) };

    await expect(store.putAgent({ ...BASE_BUNDLE, env: oversized })).rejects.toThrow(
      /exceeds the .*limit/,
    );

    await store.putAgent({ ...BASE_BUNDLE, env: { OK: "1" } });
    await expect(store.putEnv("test-agent", oversized)).rejects.toThrow(/exceeds the .*limit/);
    // The rejected write must not have clobbered the stored env.
    await expect(store.getEnv("test-agent")).resolves.toEqual({ OK: "1" });
  });

  test("an oversized-env deploy does not publish the agent", async () => {
    const { store } = makeStore();
    const oversized = { BIG: "x".repeat(MAX_ENV_SIZE) };

    await expect(store.putAgent({ ...BASE_BUNDLE, env: oversized })).rejects.toThrow();
    // The row upsert is the commit point; a failed pre-write leaves no agent.
    expect(await store.getAgent("test-agent")).toBeNull();
  });

  test("concurrent putEnv calls do not lose updates", async () => {
    const { store } = makeStore();
    await store.putAgent({ ...BASE_BUNDLE, env: { INITIAL: "value" } });

    // Fire two concurrent putEnv calls — without locking, one would overwrite the other
    await Promise.all([
      store.putEnv("test-agent", { A: "1" }),
      store.putEnv("test-agent", { B: "2" }),
    ]);

    // With serialization, the second call reads the result of the first,
    // then overwrites. So the final env should be { B: "2" }.
    expect(await store.getEnv("test-agent")).toEqual({ B: "2" });
  });

  test("putEnv on an unknown agent rejects", async () => {
    const { store } = makeStore();
    await expect(store.putEnv("missing", { A: "1" })).rejects.toThrow(/not found/);
  });

  test("getWorkerCode returns worker code", async () => {
    const { store } = makeStore();
    await store.putAgent({ ...BASE_BUNDLE, worker: "console.log('hello');" });
    expect(await store.getWorkerCode("test-agent")).toBe("console.log('hello');");
  });

  test("getClientFile returns deployed HTML and assets", async () => {
    const { store } = makeStore();
    const html = "<!DOCTYPE html><html><body>hello</body></html>";
    const js = 'console.log("app");';

    await store.putAgent({
      ...BASE_BUNDLE,
      clientFiles: { "index.html": html, "assets/index.js": js },
    });

    expect(await store.getClientFile("test-agent", "index.html")).toBe(html);
    expect(await store.getClientFile("test-agent", "assets/index.js")).toBe(js);
    expect(await store.getClientFile("test-agent", "missing.html")).toBeNull();
  });

  test("redeploy replaces client files", async () => {
    const { store } = makeStore();

    await store.putAgent({
      ...BASE_BUNDLE,
      worker: "v1",
      clientFiles: { "index.html": "<html>v1</html>", "assets/old.js": "old" },
    });
    await store.putAgent({
      ...BASE_BUNDLE,
      worker: "v2",
      clientFiles: { "index.html": "<html>v2</html>", "assets/new.js": "new" },
    });

    expect(await store.getClientFile("test-agent", "index.html")).toBe("<html>v2</html>");
    expect(await store.getClientFile("test-agent", "assets/new.js")).toBe("new");
    // The new row no longer references the old asset (its orphan blob may
    // remain in storage, but no read path can reach it).
    expect(await store.getClientFile("test-agent", "assets/old.js")).toBeNull();
    expect(await store.getWorkerCode("test-agent")).toBe("v2");
  });

  test("deleteAgent un-publishes every read path", async () => {
    const { store } = makeStore();
    await store.putAgent({ ...BASE_BUNDLE, clientFiles: { "index.html": "<html></html>" } });

    await store.deleteAgent("test-agent");

    expect(await store.getAgent("test-agent")).toBeNull();
    expect(await store.getWorkerCode("test-agent")).toBeNull();
    expect(await store.getClientFile("test-agent", "index.html")).toBeNull();
    expect(await store.getAgentConfig("test-agent")).toBeNull();
    expect(await store.getEnv("test-agent")).toBeNull();
  });

  test("deleteAgent removes the agent's secret entries (env + app-db)", async () => {
    const { store, secrets } = makeStore();

    await store.putAgent({ ...BASE_BUNDLE, env: { K: "v" } });
    await secrets.put(
      "app-db:test-agent",
      JSON.stringify({ schema: "s", role: "r", password: "p" }),
    );
    expect(await secrets.get("agent-env:test-agent")).toBe(JSON.stringify({ K: "v" }));

    await store.deleteAgent("test-agent");

    expect(await secrets.get("agent-env:test-agent")).toBeNull();
    expect(await secrets.get("app-db:test-agent")).toBeNull();
  });

  test("env round-trips through the secret store, never the agents row", async () => {
    const { store, secrets } = makeStore();

    await store.putAgent({ ...BASE_BUNDLE, env: { ASSEMBLYAI_API_KEY: "sk-123" } });

    const record = await store.getAgent("test-agent");
    expect(record).not.toBeNull();
    expect(Object.keys(record ?? {})).not.toContain("env");
    expect(await secrets.get("agent-env:test-agent")).toBe(
      JSON.stringify({ ASSEMBLYAI_API_KEY: "sk-123" }),
    );
    expect(await store.getEnv("test-agent")).toEqual({ ASSEMBLYAI_API_KEY: "sk-123" });
  });

  test("getEnv reads the secret store fresh — a secret change needs no invalidation", async () => {
    const { store, secrets } = makeStore();
    await store.putAgent({ ...BASE_BUNDLE, env: { A: "1" } });
    expect(await store.getEnv("test-agent")).toEqual({ A: "1" });

    // Another replica (or the secret route) writes the Vault record directly.
    await secrets.put("agent-env:test-agent", JSON.stringify({ A: "2" }));
    expect(await store.getEnv("test-agent")).toEqual({ A: "2" });
  });

  test("retries blob reads on transient ECONNRESET", async () => {
    const { store, storage } = makeStore();
    await store.putAgent(BASE_BUNDLE);
    const workerKey = blobKey(contentHash(BASE_BUNDLE.worker));

    const originalGetItem = storage.getItem.bind(storage);
    let callCount = 0;
    storage.getItem = (async (key: string) => {
      if (key === workerKey) {
        callCount++;
        if (callCount < 3) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          });
        }
      }
      return originalGetItem(key);
    }) as typeof storage.getItem;

    expect(await store.getWorkerCode("test-agent")).toBe(BASE_BUNDLE.worker);
    expect(callCount).toBe(3);
  });

  test("non-transient errors are not retried", async () => {
    const { store, storage } = makeStore();
    await store.putAgent(BASE_BUNDLE);

    let callCount = 0;
    storage.getItem = (async () => {
      callCount++;
      throw new Error("403 Forbidden");
    }) as typeof storage.getItem;

    await expect(store.getWorkerCode("test-agent")).rejects.toThrow("403 Forbidden");
    expect(callCount).toBe(1);
  });

  test("getAgent caches the row — second call does not hit the row store", async () => {
    const storage = createStorage();
    const agents = createMemoryAgentRows();
    const store = createBundleStore(storage, { secrets: createMemorySecretStore(), agents });
    await store.putAgent(BASE_BUNDLE);

    // Prime cache
    await store.getAgent("test-agent");

    const getSpy = vi.spyOn(agents, "get");
    const record = await store.getAgent("test-agent");
    expect(record?.slug).toBe("test-agent");
    expect(getSpy).not.toHaveBeenCalled();
  });

  test("getWorkerCode caches the blob — second call does not hit storage", async () => {
    const { store, storage } = makeStore();
    await store.putAgent({ ...BASE_BUNDLE, worker: "console.log('cached');" });

    // Prime cache
    await store.getWorkerCode("test-agent");

    let reads = 0;
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = (async (key: string) => {
      reads++;
      return originalGetItem(key);
    }) as typeof storage.getItem;

    expect(await store.getWorkerCode("test-agent")).toBe("console.log('cached');");
    expect(reads).toBe(0);
  });

  test("putAgent invalidates the row caches (worker, config, version)", async () => {
    const { store } = makeStore();

    await store.putAgent({
      ...BASE_BUNDLE,
      worker: "v1",
      agentConfig: { ...TEST_AGENT_CONFIG, name: "v1" },
    });
    // Prime caches
    await store.getAgent("test-agent");
    await store.getAgentConfig("test-agent");
    await store.getAgentVersion("test-agent");

    await store.putAgent({
      ...BASE_BUNDLE,
      worker: "v2",
      agentConfig: { ...TEST_AGENT_CONFIG, name: "v2" },
    });

    expect(await store.getWorkerCode("test-agent")).toBe("v2");
    expect((await store.getAgentConfig("test-agent"))?.name).toBe("v2");
    expect(await store.getAgentVersion("test-agent")).toBe(2);
  });

  test("getAgentConfig returns the stored config", async () => {
    const { store } = makeStore();
    await store.putAgent(BASE_BUNDLE);
    expect((await store.getAgentConfig("test-agent"))?.name).toBe(TEST_AGENT_CONFIG.name);
    expect(await store.getAgentConfig("missing")).toBeNull();
  });

  test("deleteAgent invalidates caches — subsequent reads return null", async () => {
    const { store } = makeStore();
    await store.putAgent(BASE_BUNDLE);
    await store.getAgent("test-agent");
    await store.getAgentConfig("test-agent");

    await store.deleteAgent("test-agent");

    expect(await store.getAgent("test-agent")).toBeNull();
    expect(await store.getAgentConfig("test-agent")).toBeNull();
  });
});

describe("ByteBudgetTtlCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Values sized well above the per-entry overhead so budget math dominates.
  const KB100 = 100_000;

  test("evicts least-recently-used entries once the byte budget is exceeded", () => {
    const cache = new ByteBudgetTtlCache<string>(60_000, 250_000);
    cache.set("a", "A", KB100);
    cache.set("b", "B", KB100);
    expect(cache.size).toBe(2);

    cache.set("c", "C", KB100);
    expect(cache.get("a")).toBeUndefined(); // oldest evicted
    expect(cache.get("b")).toBe("B");
    expect(cache.get("c")).toBe("C");
  });

  test("get refreshes recency — recently read entries survive eviction", () => {
    const cache = new ByteBudgetTtlCache<string>(60_000, 250_000);
    cache.set("a", "A", KB100);
    cache.set("b", "B", KB100);
    expect(cache.get("a")).toBe("A"); // "b" is now the LRU entry

    cache.set("c", "C", KB100);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
  });

  test("a value larger than the whole budget is not cached and evicts nothing", () => {
    const cache = new ByteBudgetTtlCache<string>(60_000, 250_000);
    cache.set("a", "A", KB100);
    cache.set("huge", "H", 300_000);
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
  });

  test("overwriting a key replaces its byte charge instead of adding to it", () => {
    const cache = new ByteBudgetTtlCache<string>(60_000, 250_000);
    cache.set("a", "A1", KB100);
    const charged = cache.totalBytes;
    cache.set("a", "A2", KB100);
    expect(cache.totalBytes).toBe(charged);
    expect(cache.get("a")).toBe("A2");
    expect(cache.size).toBe(1);
  });

  test("delete releases the entry's byte charge", () => {
    const cache = new ByteBudgetTtlCache<string>(60_000, 250_000);
    cache.set("a", "A", KB100);
    cache.delete("a");
    expect(cache.totalBytes).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  test("entries expire after the TTL", () => {
    vi.useFakeTimers();
    const cache = new ByteBudgetTtlCache<string>(10_000, 250_000);
    cache.set("a", "A", KB100);

    vi.advanceTimersByTime(9999);
    expect(cache.get("a")).toBe("A");

    vi.advanceTimersByTime(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.totalBytes).toBe(0);
  });

  test("null values (confirmed misses) are cacheable", () => {
    const cache = new ByteBudgetTtlCache<string | null>(60_000, 250_000);
    cache.set("missing", null, 0);
    expect(cache.get("missing")).toBeNull();
  });
});

describe("cache invalidation fences in-flight row reads", () => {
  /**
   * `invalidate()` clears the row caches, but a row read that missed BEFORE
   * the mutation and settles after it would otherwise write its pre-mutation
   * record back in under a fresh TTL. That is exactly the deploy's own
   * read-modify-write of `credential_hashes` (right after the mutation
   * lock's invalidate) computing its merge from a stale base. Blobs need no
   * fence — their keys are content hashes.
   */
  test("a row read parked across a deploy does not repopulate the row cache", async () => {
    const agents = createMemoryAgentRows();
    let entered!: () => void;
    let release!: () => void;
    const atFetch = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    let park = false;

    const originalGet = agents.get.bind(agents);
    agents.get = async (slug: string) => {
      const value = await originalGet(slug);
      if (park) {
        park = false;
        entered();
        await held;
      }
      return value;
    };

    const store = createBundleStore(createStorage(), {
      secrets: createMemorySecretStore(),
      agents,
    });
    const put = (worker: string) => store.putAgent({ ...BASE_BUNDLE, slug: "a", worker });

    await put("v1");

    // A cold read starts and parks mid-fetch, holding the v1 row.
    park = true;
    const parked = store.getAgent("a");
    await atFetch;

    // A full deploy lands and completes while that read is in flight.
    await put("v2");

    release();
    expect((await parked)?.version).toBe(1); // the parked caller still sees its snapshot

    // The cache must NOT have been poisoned by the parked read settling.
    expect((await store.getAgent("a"))?.version).toBe(2);
    expect(await store.getWorkerCode("a")).toBe("v2");
  });
});
