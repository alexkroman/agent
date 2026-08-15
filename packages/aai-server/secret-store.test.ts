// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createMemorySecretStore, createVaultSecretStore } from "./secret-store.ts";
import { secretStoreConformance } from "./store-conformance-cases.ts";
import { createRecordingSql as fakeSql } from "./test-utils.ts";

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// One case list in `store-conformance.ts`, shared with the stack arm in
// `store-conformance.scenario.test.ts`. The memory arm is unconditional, so this
// module stays covered on every machine; the stack arm adds what only a real
// Vault can hold. The suites below keep whatever each implementation
// uniquely owes — the statements it issues, and its own edge cases.

describe("SecretStore conformance: memory", () => {
  secretStoreConformance(() => createMemorySecretStore());
});

describe("createVaultSecretStore", () => {
  test("get reads decrypted_secrets by name", async () => {
    const { sql, calls } = fakeSql((query) =>
      query.includes("decrypted_secrets") ? [{ decrypted_secret: "s3cret" }] : [],
    );
    const store = createVaultSecretStore(sql);
    expect(await store.get("agent-env:my-agent")).toBe("s3cret");
    expect(calls).toEqual([
      {
        query: "select decrypted_secret from vault.decrypted_secrets where name = $1",
        params: ["agent-env:my-agent"],
      },
    ]);
  });

  test("get returns null when the name is absent", async () => {
    const { sql } = fakeSql(() => []);
    const store = createVaultSecretStore(sql);
    expect(await store.get("missing")).toBeNull();
  });

  test("put creates a new secret when the name is absent", async () => {
    const { sql, calls } = fakeSql(() => []);
    const store = createVaultSecretStore(sql);
    await store.put("agent-env:a", '{"K":"v"}');
    expect(calls.map((c) => c.query)).toEqual([
      "select id from vault.secrets where name = $1",
      "select vault.create_secret($1, $2)",
    ]);
    // create_secret takes (value, name) — in that order.
    expect(calls[1]?.params).toEqual(['{"K":"v"}', "agent-env:a"]);
  });

  test("put updates by id when the name already exists", async () => {
    const { sql, calls } = fakeSql((query) =>
      query.startsWith("select id") ? [{ id: "uuid-123" }] : [],
    );
    const store = createVaultSecretStore(sql);
    await store.put("agent-env:a", "new-value");
    expect(calls.map((c) => c.query)).toEqual([
      "select id from vault.secrets where name = $1",
      "select vault.update_secret($1, $2)",
    ]);
    expect(calls[1]?.params).toEqual(["uuid-123", "new-value"]);
  });

  /**
   * The create branch is a read-then-write, and the account paths take no
   * slug lock — `PUT /studio/account/key` and `POST /studio/cli-link/approve`
   * can write the same name at the same moment. Unhandled, the loser's
   * `create_secret` violates the unique name constraint and the caller gets a
   * 500 on an operation that should simply be idempotent.
   */
  test("put retries as an update when it loses the create race", async () => {
    const calls: string[] = [];
    // The name appears between our read and our create — exactly what a
    // concurrent writer does.
    let exists = false;
    const sql = async (query: string, params?: unknown[]) => {
      calls.push(query);
      if (query.startsWith("select id")) return exists ? [{ id: "uuid-123" }] : [];
      if (query.includes("create_secret")) {
        exists = true;
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        });
      }
      expect(params).toEqual(["uuid-123", "v2"]);
      return [];
    };

    await createVaultSecretStore(sql).put("user-key:uid-1", "v2");

    expect(calls).toEqual([
      "select id from vault.secrets where name = $1",
      "select vault.create_secret($1, $2)",
      "select id from vault.secrets where name = $1",
      "select vault.update_secret($1, $2)",
    ]);
  });

  test("put rethrows any failure that is not a lost create race", async () => {
    // Read the SQLSTATE, never the message — a permission error carries the
    // same "violates" wording and must not be swallowed as a race.
    const sql = async (query: string) => {
      if (query.startsWith("select id")) return [];
      throw Object.assign(new Error("permission denied for schema vault"), { code: "42501" });
    };
    await expect(createVaultSecretStore(sql).put("k", "v")).rejects.toThrow(/permission denied/);
  });

  test("delete removes the row by name", async () => {
    const { sql, calls } = fakeSql(() => []);
    const store = createVaultSecretStore(sql);
    await store.delete("app-db:a");
    expect(calls).toEqual([
      { query: "delete from vault.secrets where name = $1", params: ["app-db:a"] },
    ]);
  });
});

describe("createMemorySecretStore", () => {
  test("round-trips and deletes", async () => {
    const store = createMemorySecretStore();
    expect(await store.get("x")).toBeNull();
    await store.put("x", "1");
    expect(await store.get("x")).toBe("1");
    await store.put("x", "2");
    expect(await store.get("x")).toBe("2");
    await store.delete("x");
    expect(await store.get("x")).toBeNull();
  });
});
