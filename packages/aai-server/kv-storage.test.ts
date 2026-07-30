// Copyright 2025 the AAI authors. MIT license.
import { createUnstorageKv } from "@alexkroman1/aai/runtime";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { agentKvPrefix } from "./constants.ts";
import { createUpstashKvStorage, wipeAgentKv } from "./kv-storage.ts";

// The real upstash driver would talk to a live Upstash REST endpoint, and
// vi.mock("@upstash/redis") cannot reach inside externalized node_modules —
// so mock the driver module itself (imported directly by kv-storage.ts)
// with an in-memory driver that records constructor options and per-set TTLs.
// The driver's own Redis semantics are unstorage's tested code; these tests
// cover OUR wiring: env gating, option pass-through, prefix layout, TTL
// forwarding, and the delete-time wipe.
const { driverCalls, memory, ttlCalls } = vi.hoisted(() => ({
  driverCalls: [] as unknown[],
  memory: new Map<string, unknown>(),
  ttlCalls: [] as Array<{ key: string; ttl: number | undefined }>,
}));

vi.mock("unstorage/drivers/upstash", () => ({
  default: (opts: unknown) => {
    driverCalls.push(opts);
    return {
      name: "upstash",
      async hasItem(key: string) {
        return memory.has(key);
      },
      async getItem(key: string) {
        return memory.get(key) ?? null;
      },
      async setItem(key: string, value: unknown, tOptions?: { ttl?: number }) {
        memory.set(key, value);
        ttlCalls.push({ key, ttl: tOptions?.ttl });
      },
      async removeItem(key: string) {
        memory.delete(key);
      },
      async getKeys() {
        return [...memory.keys()];
      },
    };
  },
}));

const UPSTASH_ENV = {
  UPSTASH_REDIS_REST_URL: "https://fly-aai.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

function upstashStorage() {
  const storage = createUpstashKvStorage(UPSTASH_ENV);
  if (!storage) throw new Error("expected storage");
  return storage;
}

beforeEach(() => {
  driverCalls.length = 0;
  memory.clear();
  ttlCalls.length = 0;
});

describe("createUpstashKvStorage", () => {
  test("returns null unless BOTH credentials are set", () => {
    expect(createUpstashKvStorage({})).toBeNull();
    expect(createUpstashKvStorage({ UPSTASH_REDIS_REST_URL: "https://x" })).toBeNull();
    expect(createUpstashKvStorage({ UPSTASH_REDIS_REST_TOKEN: "t" })).toBeNull();
    expect(createUpstashKvStorage(UPSTASH_ENV)).not.toBeNull();
  });

  test("passes the configured credentials to the driver", () => {
    upstashStorage();
    expect(driverCalls).toEqual([{ url: "https://fly-aai.upstash.io", token: "test-token" }]);
  });

  test("Kv round-trips under the agent KV prefix", async () => {
    const kv = createUnstorageKv({ storage: upstashStorage(), prefix: agentKvPrefix("my-agent") });
    await kv.set("greeting", { hello: "world" });
    expect(await kv.get("greeting")).toEqual({ hello: "world" });
    // Same namespace shape as the S3 fallback, `:`-normalized by unstorage.
    expect([...memory.keys()]).toEqual(["agents:my-agent:kv:greeting"]);
  });

  test("expireIn is forwarded to the driver as a server-side ttl (seconds)", async () => {
    const kv = createUnstorageKv({ storage: upstashStorage(), prefix: agentKvPrefix("my-agent") });
    await kv.set("note", "remember me", { expireIn: 60_000 });
    expect(ttlCalls.at(-1)).toEqual({ key: "agents:my-agent:kv:note", ttl: 60 });
  });
});

describe("wipeAgentKv", () => {
  test("removes only the target agent's keys", async () => {
    const storage = upstashStorage();
    const kvA = createUnstorageKv({ storage, prefix: agentKvPrefix("agent-a") });
    const kvB = createUnstorageKv({ storage, prefix: agentKvPrefix("agent-b") });
    await kvA.set("k1", 1);
    await kvA.set("k2", 2);
    await kvB.set("k1", 3);

    await wipeAgentKv(storage, "agent-a");

    expect(await kvA.get("k1")).toBeNull();
    expect(await kvA.get("k2")).toBeNull();
    expect(await kvB.get("k1")).toBe(3);
  });

  test("is a no-op for an agent with no KV data", async () => {
    await expect(wipeAgentKv(upstashStorage(), "nobody")).resolves.toBeUndefined();
  });
});
