// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import {
  bumpSlugEpoch,
  createMemorySlugEpochs,
  createPgSlugEpochs,
  readSlugEpoch,
} from "./platform-epoch.ts";
import type { SqlExec } from "./secret-store.ts";

describe("createMemorySlugEpochs", () => {
  test("starts at 0 and increments per bump", async () => {
    const epochs = createMemorySlugEpochs();
    await expect(epochs.get("my-agent")).resolves.toBe(0);
    await epochs.bump("my-agent");
    await expect(epochs.get("my-agent")).resolves.toBe(1);
    await epochs.bump("my-agent");
    await expect(epochs.get("my-agent")).resolves.toBe(2);
  });

  test("slugs are independent", async () => {
    const epochs = createMemorySlugEpochs();
    await epochs.bump("a");
    await expect(epochs.get("b")).resolves.toBe(0);
  });
});

/** Fake `SqlExec` reproducing the upsert/select over an in-memory map. */
function fakeEpochDb() {
  const rows = new Map<string, number>();
  const statements: string[] = [];
  const exec: SqlExec = (query, params = []) => {
    statements.push(query);
    if (query.startsWith("create")) return Promise.resolve([]);
    const [slug] = params as [string];
    if (query.startsWith("insert")) {
      rows.set(slug, (rows.get(slug) ?? 0) + 1);
      return Promise.resolve([]);
    }
    const epoch = rows.get(slug);
    return Promise.resolve(epoch === undefined ? [] : [{ epoch }]);
  };
  return { exec, rows, statements };
}

describe("createPgSlugEpochs", () => {
  test("starts at 0 and increments per bump", async () => {
    const db = fakeEpochDb();
    const epochs = createPgSlugEpochs(db.exec);
    await expect(epochs.get("my-agent")).resolves.toBe(0);
    await epochs.bump("my-agent");
    await expect(epochs.get("my-agent")).resolves.toBe(1);
  });

  test("coerces bigint-ish driver values to number", async () => {
    const exec: SqlExec = (query) =>
      Promise.resolve(
        query.startsWith("select") ? [{ epoch: "3" }] : [], // drivers return bigint as string
      );
    const epochs = createPgSlugEpochs(exec);
    await expect(epochs.get("my-agent")).resolves.toBe(3);
  });

  test("ensures schema and table once", async () => {
    const db = fakeEpochDb();
    const epochs = createPgSlugEpochs(db.exec);
    await epochs.bump("a");
    await epochs.get("a");
    expect(db.statements.filter((s) => s.startsWith("create")).length).toBe(2);
  });
});

describe("failure posture", () => {
  test("bumpSlugEpoch swallows and logs — the mutation must not fail", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const epochs = {
      bump: () => Promise.reject(new Error("db down")),
      get: () => Promise.resolve(0),
    };
    await expect(bumpSlugEpoch(epochs, "my-agent")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("readSlugEpoch degrades to the fallback — session start must not die", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const epochs = {
      bump: () => Promise.resolve(),
      get: () => Promise.reject(new Error("db down")),
    };
    await expect(readSlugEpoch(epochs, "my-agent", 7)).resolves.toBe(7);
    warn.mockRestore();
  });
});

// ── Read caching (Postgres implementation) ────────────────────────────────

describe("createPgSlugEpochs read cache", () => {
  function countingSql(epoch = 3) {
    const calls: string[] = [];
    const sql = (text: string) => {
      calls.push(text);
      return Promise.resolve(text.startsWith("select") ? [{ epoch }] : []);
    };
    return {
      sql: sql as unknown as SqlExec,
      selects: () => calls.filter((c) => c.startsWith("select")).length,
    };
  }

  test("repeated reads of one slug hit the database once", async () => {
    const { sql, selects } = countingSql();
    const epochs = createPgSlugEpochs(sql);

    expect(await epochs.get("a")).toBe(3);
    expect(await epochs.get("a")).toBe(3);
    expect(await epochs.get("a")).toBe(3);

    expect(selects()).toBe(1);
  });

  test("distinct slugs are cached separately", async () => {
    const { sql, selects } = countingSql();
    const epochs = createPgSlugEpochs(sql);

    await epochs.get("a");
    await epochs.get("b");

    expect(selects()).toBe(2);
  });

  // The TTL may hide another replica's bump for up to a second; it must never
  // hide this replica's own.
  test("a local bump invalidates the cached read immediately", async () => {
    const { sql, selects } = countingSql();
    const epochs = createPgSlugEpochs(sql);

    await epochs.get("a");
    await epochs.bump("a");
    await epochs.get("a");

    expect(selects()).toBe(2);
  });
});
