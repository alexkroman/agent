// Copyright 2025 the AAI authors. MIT license.
import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import {
  BLOB_MISS,
  blobKey,
  contentHash,
  createBlobCache,
  createBundleStore,
} from "./bundle-store.ts";
import { MAX_ENV_SIZE } from "./constants.ts";
import { createMemorySecretStore, type SecretStore } from "./secret-store.ts";

function makeStore(secrets = createMemorySecretStore()) {
  const storage = createMemoryBlobStorage();
  const store = createBundleStore(storage, { secrets, agents: createMemoryAgentRows() });
  return { storage, store, secrets };
}

const BASE_BUNDLE = {
  slug: "test-agent",
  env: {},
  worker: "console.log('w');",
  clientFiles: {},
  credential_hashes: ["hash1"],
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

  test("concurrent putEnv calls are serialized — the critical sections never overlap", async () => {
    // `putEnv` is a WHOLESALE replace inside `withLock`, so "the final env is
    // { B: '2' }" holds with the lock deleted: there is no read-modify-write to
    // lose. What the lock really buys is that the two critical sections do not
    // OVERLAP, so this observes the overlap directly — every secret write
    // yields a macrotask, which is exactly where an unserialized second writer
    // would slot in.
    const backing = createMemorySecretStore();
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const secrets: SecretStore = {
      get: (name) => backing.get(name),
      delete: (name) => backing.delete(name),
      async put(name, value) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        events.push(`enter:${value}`);
        await sleep(0);
        await backing.put(name, value);
        events.push(`exit:${value}`);
        inFlight -= 1;
      },
    };
    const store = createBundleStore(createMemoryBlobStorage(), {
      secrets,
      agents: createMemoryAgentRows(),
    });

    await store.putAgent({ ...BASE_BUNDLE, env: { INITIAL: "value" } });
    events.length = 0;
    maxInFlight = 0;

    await Promise.all([
      store.putEnv("test-agent", { A: "1" }),
      store.putEnv("test-agent", { B: "2" }),
    ]);

    expect(maxInFlight).toBe(1);
    // The lock is FIFO, so the whole transcript is deterministic: each write
    // completes before the next one begins, in arrival order.
    expect(events).toEqual([
      'enter:{"A":"1"}',
      'exit:{"A":"1"}',
      'enter:{"B":"2"}',
      'exit:{"B":"2"}',
    ]);
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
    expect(await store.getEnv("test-agent")).toBeNull();
  });

  /**
   * The env record goes; a LEGACY `app-db:<slug>` row deliberately does not.
   *
   * It used to delete both, when the platform provisioned a database per app and
   * the delete route dropped that database first. Nothing writes such a row now —
   * and a row that survives from before holds the ONLY credential for a database
   * that may still exist, so deleting it strands the data with no way back in.
   * That is the "leaked, out loud" failure `orphan-previews.ts` names, and it is
   * why this asserts the survival rather than the sweep.
   */
  test("deleteAgent removes the env record and leaves a legacy app-db row alone", async () => {
    const { store, secrets } = makeStore();

    await store.putAgent({ ...BASE_BUNDLE, env: { K: "v" } });
    const legacy = JSON.stringify({ schema: "s", role: "r", password: "p" });
    await secrets.put("app-db:test-agent", legacy);
    expect(await secrets.get("agent-env:test-agent")).toBe(JSON.stringify({ K: "v" }));

    await store.deleteAgent("test-agent");

    expect(await secrets.get("agent-env:test-agent")).toBeNull();
    expect(await secrets.get("app-db:test-agent")).toBe(legacy);
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

  /**
   * The write path is strictly MORE exposed to these than the read path — it
   * moves the ~8 MB worker plus every client file, where a read of the same
   * deploy usually moves nothing (the caches serve it) — and it went unwrapped
   * for as long as the read path was wrapped. One reset on any single file
   * failed the whole deploy; for studio Publish that reached a user as a build
   * failure carrying a network message.
   */
  test("retries blob WRITES on transient ECONNRESET", async () => {
    const { store, storage } = makeStore();
    const workerKey = blobKey(contentHash(BASE_BUNDLE.worker));

    const originalSetItem = storage.setItem.bind(storage);
    let callCount = 0;
    storage.setItem = (async (key: string, value: string) => {
      if (key === workerKey) {
        callCount++;
        if (callCount < 3) {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          });
        }
      }
      return originalSetItem(key, value);
    }) as typeof storage.setItem;

    await store.putAgent(BASE_BUNDLE);

    expect(callCount).toBe(3);
    // Retrying is safe by construction, not by argument: the key is the
    // content hash and uploads upsert, so every attempt writes identical bytes
    // to the same key — and the deploy still published.
    expect(await store.getWorkerCode("test-agent")).toBe(BASE_BUNDLE.worker);
  });

  test("a non-transient write failure fails the deploy without retrying", async () => {
    const { store, storage } = makeStore();
    let callCount = 0;
    storage.setItem = (async () => {
      callCount++;
      throw new Error("403 Forbidden");
    }) as typeof storage.setItem;

    await expect(store.putAgent(BASE_BUNDLE)).rejects.toThrow("403 Forbidden");
    expect(callCount).toBe(1);
    // The row is the deploy's commit point, and blobs land first — so a failed
    // blob write must leave no agent published.
    expect(await store.getAgent("test-agent")).toBeNull();
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
    const storage = createMemoryBlobStorage();
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
    });
    // Prime caches
    await store.getAgent("test-agent");
    await store.getAgentVersion("test-agent");

    await store.putAgent({
      ...BASE_BUNDLE,
      worker: "v2",
    });

    expect(await store.getWorkerCode("test-agent")).toBe("v2");
    expect(await store.getAgentVersion("test-agent")).toBe(2);
  });

  test("an unknown slug reads as null", async () => {
    const { store } = makeStore();
    await store.putAgent(BASE_BUNDLE);
    expect(await store.getAgent("missing")).toBeNull();
  });

  test("deleteAgent invalidates caches — subsequent reads return null", async () => {
    const { store } = makeStore();
    await store.putAgent(BASE_BUNDLE);
    await store.getAgent("test-agent");

    await store.deleteAgent("test-agent");

    expect(await store.getAgent("test-agent")).toBeNull();
  });
});

describe("createBlobCache", () => {
  test("evicts by total value bytes, not entry count", () => {
    // Values sized well above the per-entry overhead so budget math dominates.
    const cache = createBlobCache(60_000, 250_000);
    cache.set("a", "A".repeat(100_000));
    cache.set("b", "B".repeat(100_000));
    expect(cache.size).toBe(2);

    cache.set("c", "C".repeat(100_000));
    expect(cache.get("a")).toBeUndefined(); // oldest evicted
    expect(cache.get("b")).toBe("B".repeat(100_000));
    expect(cache.get("c")).toBe("C".repeat(100_000));
  });

  test("a value larger than the whole budget is not cached and evicts nothing", () => {
    const cache = createBlobCache(60_000, 250_000);
    cache.set("a", "A".repeat(100_000));
    cache.set("huge", "H".repeat(300_000));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
  });

  test("entries expire after the TTL", async () => {
    // Real clock: lru-cache reads `performance.now` through a reference
    // captured at module load, which fake timers cannot reach.
    const cache = createBlobCache(20, 250_000);
    cache.set("a", "A".repeat(100_000));
    expect(cache.get("a")).toBeDefined();

    await vi.waitFor(() => expect(cache.get("a")).toBeUndefined());
  });

  test("the miss sentinel is cacheable and charged the per-entry overhead", () => {
    const cache = createBlobCache(60_000, 250_000);
    cache.set("missing", BLOB_MISS);
    expect(cache.get("missing")).toBe(BLOB_MISS);
    expect(cache.calculatedSize).toBeGreaterThan(0);
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
    const { promise: atFetch, resolve: entered } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
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

    const store = createBundleStore(createMemoryBlobStorage(), {
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

  test("a deploy of one slug does not fence another slug's in-flight read", async () => {
    // The fence is per slug: a mutation makes ONE slug's parked reads stale.
    // Under a store-wide counter every deploy discarded the cache write of
    // every other slug's concurrent read — always safe, never necessary, and
    // it re-reads Postgres precisely when the replica is busiest.
    const agents = createMemoryAgentRows();
    const { promise: atFetch, resolve: entered } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    let parkSlug: string | null = null;

    const originalGet = agents.get.bind(agents);
    agents.get = async (slug: string) => {
      const value = await originalGet(slug);
      if (parkSlug === slug) {
        parkSlug = null;
        entered();
        await held;
      }
      return value;
    };

    const store = createBundleStore(createMemoryBlobStorage(), {
      secrets: createMemorySecretStore(),
      agents,
    });
    await store.putAgent({ ...BASE_BUNDLE, slug: "a", worker: "a-v1" });
    await store.putAgent({ ...BASE_BUNDLE, slug: "b", worker: "b-v1" });
    store.invalidate?.("a");

    // A cold read of "a" parks mid-fetch...
    parkSlug = "a";
    const parked = store.getAgent("a");
    await atFetch;

    // ...while an unrelated slug is deployed.
    await store.putAgent({ ...BASE_BUNDLE, slug: "b", worker: "b-v2" });

    release();
    await parked;

    // "a" was never mutated, so its parked read's value is still current and
    // belongs in the cache — reading it again must not go back to Postgres.
    const get = vi.spyOn(agents, "get");
    expect((await store.getAgent("a"))?.slug).toBe("a");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("single-flight over cold reads", () => {
  /**
   * The caches above only serve a read that already happened. On a cold
   * replica a burst for one deploy misses together — a page load fetches its
   * assets in parallel — and each miss used to become its own Postgres read
   * and its own Storage download.
   */
  test("concurrent row misses for one slug issue ONE read", async () => {
    const agents = createMemoryAgentRows();
    const store = createBundleStore(createMemoryBlobStorage(), {
      secrets: createMemorySecretStore(),
      agents,
    });
    await store.putAgent({ ...BASE_BUNDLE, slug: "a" });
    store.invalidate?.("a");

    const get = vi.spyOn(agents, "get");
    const rows = await Promise.all([store.getAgent("a"), store.getAgent("a"), store.getAgent("a")]);

    expect(get).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r?.slug)).toEqual(["a", "a", "a"]);
  });

  test("concurrent blob misses for one hash issue ONE download", async () => {
    const storage = createMemoryBlobStorage();
    const store = createBundleStore(storage, {
      secrets: createMemorySecretStore(),
      agents: createMemoryAgentRows(),
    });
    await store.putAgent({
      ...BASE_BUNDLE,
      slug: "a",
      clientFiles: { "index.html": "<html></html>", "assets/index.js": "console.log(1);" },
    });
    store.invalidate?.("a");

    const getItem = vi.spyOn(storage, "getItem");
    const files = await Promise.all([
      store.getClientFile("a", "assets/index.js"),
      store.getClientFile("a", "assets/index.js"),
    ]);

    expect(files).toEqual(["console.log(1);", "console.log(1);"]);
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  test("version misses coalesce too", async () => {
    const agents = createMemoryAgentRows();
    const store = createBundleStore(createMemoryBlobStorage(), {
      secrets: createMemorySecretStore(),
      agents,
    });
    await store.putAgent({ ...BASE_BUNDLE, slug: "a" });
    store.invalidate?.("a");

    const getVersion = vi.spyOn(agents, "getVersion");
    await Promise.all([store.getAgentVersion("a"), store.getAgentVersion("a")]);

    expect(getVersion).toHaveBeenCalledTimes(1);
  });

  /**
   * The dangerous half. Sharing a read is only safe while the row cannot have
   * changed under it: a caller arriving AFTER a mutation must not be served a
   * read that started before it — that is the mutation lock's whole premise
   * (`createMutationLock` invalidates, then the handler reads its merge base).
   */
  test("a caller after invalidate() does not join the pre-invalidate read", async () => {
    const agents = createMemoryAgentRows();
    const { promise: atFetch, resolve: entered } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
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

    const store = createBundleStore(createMemoryBlobStorage(), {
      secrets: createMemorySecretStore(),
      agents,
    });
    await store.putAgent({ ...BASE_BUNDLE, slug: "a", worker: "v1" });
    store.invalidate?.("a");

    // A cold read parks holding the v1 row.
    park = true;
    const parked = store.getAgent("a");
    await atFetch;

    // A deploy lands (its putAgent invalidates), then a fresh caller arrives
    // while the parked read is STILL in flight.
    await store.putAgent({ ...BASE_BUNDLE, slug: "a", worker: "v2" });
    const after = store.getAgent("a");

    release();
    expect((await parked)?.worker_hash).toBe(contentHash("v1"));
    expect((await after)?.worker_hash).toBe(contentHash("v2"));
  });
});
