// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createMemorySecretStore, createVaultSecretStore } from "./secret-store.ts";
import { createRecordingSql as fakeSql } from "./test-utils.ts";

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
