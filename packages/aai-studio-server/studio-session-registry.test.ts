// Copyright 2026 the AAI authors. MIT license.

import { createRecordingSql } from "aai-server/test-utils";
import { describe, expect, test, vi } from "vitest";
import {
  createMemoryStudioSessionRegistry,
  createPgStudioSessionRegistry,
  type StudioSessionRecord,
} from "./studio-session-registry.ts";
import { studioSessionRegistryConformance } from "./studio-store-conformance.ts";

const SCOPE = "scope";
const PROJECT = "proj";

const record = (owner: string): StudioSessionRecord => ({
  chatUrl: `https://${owner}.example/studio/chat`,
  chatToken: "chat-token",
  guestOrigin: `wss://${owner}.example`,
  sandboxToken: "sandbox-token",
  owner,
});

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// One case list in `studio-store-conformance.ts`, shared with the stack arm in
// `aai-server/store-conformance.scenario.test.ts`. Unconditional here, so the
// module stays covered on every machine.

describe("StudioSessionRegistry conformance: memory", () => {
  studioSessionRegistryConformance(() => createMemoryStudioSessionRegistry());
});

describe("memory studio session registry", () => {
  test("claim then get round-trips the record", async () => {
    const registry = createMemoryStudioSessionRegistry();
    await registry.claim(SCOPE, PROJECT, record("replica-a"));
    expect(await registry.get(SCOPE, PROJECT)).toEqual(record("replica-a"));
  });

  test("get resolves null once the lease expires", async () => {
    vi.useFakeTimers();
    try {
      const registry = createMemoryStudioSessionRegistry({ leaseMs: 1000 });
      await registry.claim(SCOPE, PROJECT, record("replica-a"));
      vi.advanceTimersByTime(1001);
      expect(await registry.get(SCOPE, PROJECT)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("touch extends the lease — a peer's broker call is activity", async () => {
    vi.useFakeTimers();
    try {
      const registry = createMemoryStudioSessionRegistry({ leaseMs: 1000 });
      await registry.claim(SCOPE, PROJECT, record("replica-a"));
      vi.advanceTimersByTime(900);
      await registry.touch(SCOPE, PROJECT);
      vi.advanceTimersByTime(900);
      expect(await registry.get(SCOPE, PROJECT)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("release only drops the row for the CURRENT owner", async () => {
    // Every release runs after an await, by which point a replacement may
    // have claimed the key — evicting it would strand a live guest.
    const registry = createMemoryStudioSessionRegistry();
    await registry.claim(SCOPE, PROJECT, record("replica-b"));
    await registry.release(SCOPE, PROJECT, "replica-a");
    expect(await registry.get(SCOPE, PROJECT)).toEqual(record("replica-b"));
    await registry.release(SCOPE, PROJECT, "replica-b");
    expect(await registry.get(SCOPE, PROJECT)).toBeNull();
  });

  test("scopes rows by (scope, project)", async () => {
    const registry = createMemoryStudioSessionRegistry();
    await registry.claim(SCOPE, PROJECT, record("replica-a"));
    expect(await registry.get("other-scope", PROJECT)).toBeNull();
    expect(await registry.get(SCOPE, "other-project")).toBeNull();
  });
});

describe("postgres studio session registry", () => {
  function fakeSql(rows: Record<string, unknown>[] = []) {
    return createRecordingSql((query) => (query.trimStart().startsWith("select") ? rows : []));
  }

  test("claim upserts every field plus the lease", async () => {
    const { sql, calls } = fakeSql();
    const registry = createPgStudioSessionRegistry(sql, { leaseMs: 5000 });
    await registry.claim(SCOPE, PROJECT, record("replica-a"));
    const insert = calls.find((c) => c.query.includes("insert into"));
    expect(insert?.params).toEqual([
      SCOPE,
      PROJECT,
      record("replica-a").chatUrl,
      "chat-token",
      record("replica-a").guestOrigin,
      "sandbox-token",
      "replica-a",
      5000,
    ]);
    expect(insert?.query).toContain("on conflict (scope, project) do update");
  });

  test("get filters expired leases and maps the row", async () => {
    const { sql, calls } = fakeSql([
      {
        chat_url: "https://replica-a.example/studio/chat",
        chat_token: "chat-token",
        guest_origin: "wss://replica-a.example",
        sandbox_token: "sandbox-token",
        owner: "replica-a",
      },
    ]);
    const registry = createPgStudioSessionRegistry(sql);
    expect(await registry.get(SCOPE, PROJECT)).toEqual(record("replica-a"));
    const select = calls.find((c) => c.query.trimStart().startsWith("select"));
    expect(select?.query).toContain("expires_at > now()");
  });

  test("release is owner-scoped in SQL", async () => {
    const { sql, calls } = fakeSql();
    const registry = createPgStudioSessionRegistry(sql);
    await registry.release(SCOPE, PROJECT, "replica-a");
    const del = calls.find((c) => c.query.includes("delete from"));
    expect(del?.query).toContain("owner = $3");
    expect(del?.params).toEqual([SCOPE, PROJECT, "replica-a"]);
  });
});
