// Copyright 2025 the AAI authors. MIT license.
import { createStorage } from "unstorage";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ByteBudgetTtlCache, createBundleStore } from "./bundle-store.ts";
import { agentObjectKey } from "./constants.ts";
import { importMasterKey } from "./secrets.ts";
import { TEST_AGENT_CONFIG } from "./test-utils.ts";

describe("bundle store (unstorage)", () => {
  test("putAgent + getManifest round-trip", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { ASSEMBLYAI_API_KEY: "key123" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const manifest = await store.getManifest("test-agent");
    expect(manifest).not.toBeNull();
    expect(manifest?.slug).toBe("test-agent");
  });

  test("getManifest returns cached data on second read", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { ASSEMBLYAI_API_KEY: "key123" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const first = await store.getManifest("test-agent");
    expect(first).not.toBeNull();
    expect(first?.slug).toBe("test-agent");

    const second = await store.getManifest("test-agent");
    expect(second).not.toBeNull();
    expect(second?.slug).toBe("test-agent");
  });

  test("getManifest returns null for non-existent agent", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    const result = await store.getManifest("nonexistent");
    expect(result).toBeNull();
  });

  test("getManifest treats corrupt stored JSON as missing instead of throwing", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await storage.setItem(agentObjectKey("bad-agent", "manifest.json"), "{not json at all");

    await expect(store.getManifest("bad-agent")).resolves.toBeNull();
    warnSpy.mockRestore();
  });

  test("getManifest treats a schema-invalid manifest as missing instead of throwing", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Valid JSON, wrong shape — a corrupt or half-written manifest object.
    await storage.setItem(
      agentObjectKey("bad-agent", "manifest.json"),
      JSON.stringify({ slug: 42 }),
    );

    await expect(store.getManifest("bad-agent")).resolves.toBeNull();
    warnSpy.mockRestore();
  });

  test("concurrent putEnv calls do not lose updates", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { INITIAL: "value" },
      worker: "console.log('w');",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    // Fire two concurrent putEnv calls — without locking, one would overwrite the other
    await Promise.all([
      store.putEnv("test-agent", { A: "1" }),
      store.putEnv("test-agent", { B: "2" }),
    ]);

    // The last write wins, but it must have completed after the first.
    const env = await store.getEnv("test-agent");
    expect(env).not.toBeNull();
    // With serialization, the second call reads the result of the first,
    // then overwrites. So the final env should be { B: "2" }.
    expect(env).toEqual({ B: "2" });
  });

  test("getWorkerCode returns worker code", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "console.log('hello');",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const code = await store.getWorkerCode("test-agent");
    expect(code).toBe("console.log('hello');");
  });

  test("getClientFile returns deployed HTML and assets", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    const html = "<!DOCTYPE html><html><body>hello</body></html>";
    const js = 'console.log("app");';

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "w",
      clientFiles: { "index.html": html, "assets/index.js": js },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    expect(await store.getClientFile("test-agent", "index.html")).toBe(html);
    expect(await store.getClientFile("test-agent", "assets/index.js")).toBe(js);
    expect(await store.getClientFile("test-agent", "missing.html")).toBeNull();
  });

  test("redeploy replaces client files", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "v1",
      clientFiles: { "index.html": "<html>v1</html>", "assets/old.js": "old" },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "v2",
      clientFiles: { "index.html": "<html>v2</html>", "assets/new.js": "new" },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    expect(await store.getClientFile("test-agent", "index.html")).toBe("<html>v2</html>");
    expect(await store.getClientFile("test-agent", "assets/new.js")).toBe("new");
    // Old asset should be gone after redeploy
    expect(await store.getClientFile("test-agent", "assets/old.js")).toBeNull();
    expect(await store.getWorkerCode("test-agent")).toBe("v2");
  });

  test("deleteAgent removes all files", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "w",
      clientFiles: { "index.html": "<html></html>" },
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    await store.deleteAgent("test-agent");

    expect(await store.getManifest("test-agent")).toBeNull();
    expect(await store.getWorkerCode("test-agent")).toBeNull();
  });

  test("retries getWorkerCode on transient ECONNRESET", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "console.log('w');",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    const originalGetItem = storage.getItem.bind(storage);
    let callCount = 0;
    storage.getItem = (async (key: string) => {
      if (key === "agents/test-agent/worker.js") {
        callCount++;
        if (callCount < 3) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          });
        }
      }
      return originalGetItem(key);
    }) as typeof storage.getItem;

    const code = await store.getWorkerCode("test-agent");
    expect(code).toBe("console.log('w');");
    expect(callCount).toBe(3);
  });

  test("getAgentConfig gives up after repeated transient failures", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    storage.getItem = (async (key: string) => {
      if (key === "agents/test-agent/config.json") {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        });
      }
      return null;
    }) as typeof storage.getItem;

    await expect(store.getAgentConfig("test-agent")).rejects.toThrow("fetch failed");
  });

  test("non-transient errors are not retried", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    let callCount = 0;
    storage.getItem = (async () => {
      callCount++;
      throw new Error("403 Forbidden");
    }) as typeof storage.getItem;

    await expect(store.getWorkerCode("missing")).rejects.toThrow("403 Forbidden");
    expect(callCount).toBe(1);
  });

  test("getManifest caches result — second call does not hit storage", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { A: "1" },
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    // Prime cache
    await store.getManifest("test-agent");

    let reads = 0;
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = (async (key: string) => {
      reads++;
      return originalGetItem(key);
    }) as typeof storage.getItem;

    const manifest = await store.getManifest("test-agent");
    expect(manifest?.env).toEqual({ A: "1" });
    expect(reads).toBe(0);
  });

  test("putEnv invalidates manifest cache", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { A: "1" },
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    // Prime cache
    const before = await store.getEnv("test-agent");
    expect(before).toEqual({ A: "1" });

    await store.putEnv("test-agent", { A: "2" });
    const after = await store.getEnv("test-agent");
    expect(after).toEqual({ A: "2" });
  });

  test("getWorkerCode caches result — second call does not hit storage", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "console.log('cached');",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    // Prime cache
    await store.getWorkerCode("test-agent");

    let reads = 0;
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = (async (key: string) => {
      reads++;
      return originalGetItem(key);
    }) as typeof storage.getItem;

    const code = await store.getWorkerCode("test-agent");
    expect(code).toBe("console.log('cached');");
    expect(reads).toBe(0);
  });

  test("putAgent invalidates the worker-code cache", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    const bundle = {
      slug: "test-agent",
      env: {},
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    };
    await store.putAgent({ ...bundle, worker: "v1" });
    expect(await store.getWorkerCode("test-agent")).toBe("v1");

    await store.putAgent({ ...bundle, worker: "v2" });
    expect(await store.getWorkerCode("test-agent")).toBe("v2");
  });

  test("getAgentConfig caches result", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    await store.getAgentConfig("test-agent");

    let reads = 0;
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = (async (key: string) => {
      reads++;
      return originalGetItem(key);
    }) as typeof storage.getItem;

    const config = await store.getAgentConfig("test-agent");
    expect(config?.name).toBe(TEST_AGENT_CONFIG.name);
    expect(reads).toBe(0);
  });

  test("putAgent invalidates both manifest and config caches", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { A: "1" },
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: { ...TEST_AGENT_CONFIG, name: "v1" },
    });
    // Prime caches
    await store.getManifest("test-agent");
    await store.getAgentConfig("test-agent");

    await store.putAgent({
      slug: "test-agent",
      env: { A: "2" },
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: { ...TEST_AGENT_CONFIG, name: "v2" },
    });

    expect((await store.getManifest("test-agent"))?.env).toEqual({ A: "2" });
    expect((await store.getAgentConfig("test-agent"))?.name).toBe("v2");
  });

  test("getManifest and getAgentConfig handle drivers that auto-parse JSON", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: { A: "1" },
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });

    // Simulate a driver that returns `.json` keys pre-parsed instead of raw
    // strings (readJson must use the object directly, no re-serialization).
    const originalGetItem = storage.getItem.bind(storage);
    storage.getItem = (async (key: string) => {
      const value = await originalGetItem(key);
      return key.endsWith(".json") && typeof value === "string" ? JSON.parse(value) : value;
    }) as typeof storage.getItem;

    expect((await store.getManifest("test-agent"))?.env).toEqual({ A: "1" });
    expect((await store.getAgentConfig("test-agent"))?.name).toBe(TEST_AGENT_CONFIG.name);
  });

  test("deleteAgent invalidates cache — subsequent reads return null", async () => {
    const storage = createStorage();
    const masterKey = await importMasterKey("test-secret");
    const store = createBundleStore(storage, { masterKey });

    await store.putAgent({
      slug: "test-agent",
      env: {},
      worker: "w",
      clientFiles: {},
      credential_hashes: ["hash1"],
      agentConfig: TEST_AGENT_CONFIG,
    });
    await store.getManifest("test-agent");
    await store.getAgentConfig("test-agent");

    await store.deleteAgent("test-agent");

    expect(await store.getManifest("test-agent")).toBeNull();
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
