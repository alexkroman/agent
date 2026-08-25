// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createMemoryAgentRows, createPgAgentRows } from "./agent-store.ts";
import type { SqlExec } from "./secret-store.ts";
import { agentRowsConformance } from "./store-conformance-cases.ts";

const RECORD = {
  slug: "my-agent",
  credential_hashes: ["h1"],
  worker_hash: "abc123",
  client_files: { "index.html": "def456" },
};

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// One case list in `store-conformance.ts`, shared with the stack arm in
// `store-conformance.scenario.test.ts`. The memory arm is unconditional, so this
// module stays covered on every machine; the stack arm adds what only a real
// Postgres can hold. The suites below keep whatever each implementation
// uniquely owes — the statements it issues, and its own edge cases.

describe("AgentRows conformance: memory", () => {
  agentRowsConformance(() => createMemoryAgentRows());
});

describe("createMemoryAgentRows", () => {
  test("put/get round-trip with version bump on redeploy", async () => {
    const rows = createMemoryAgentRows();
    await rows.put(RECORD);
    expect((await rows.get("my-agent"))?.version).toBe(1);

    await rows.put({ ...RECORD, worker_hash: "v2hash" });
    const after = await rows.get("my-agent");
    expect(after?.version).toBe(2);
    expect(after?.worker_hash).toBe("v2hash");
  });

  test("getVersion is null for missing agents and after delete", async () => {
    const rows = createMemoryAgentRows();
    expect(await rows.getVersion("nope")).toBeNull();
    await rows.put(RECORD);
    expect(await rows.getVersion("my-agent")).toBe(1);
    await rows.delete("my-agent");
    expect(await rows.getVersion("my-agent")).toBeNull();
    expect(await rows.get("my-agent")).toBeNull();
  });

  test("stored records are isolated from later input mutation", async () => {
    const rows = createMemoryAgentRows();
    const input = { ...RECORD, credential_hashes: ["h1"] };
    await rows.put(input);
    input.credential_hashes.push("attacker");
    expect((await rows.get("my-agent"))?.credential_hashes).toEqual(["h1"]);
  });
});

describe("createPgAgentRows", () => {
  /** In-memory SqlExec fake covering the four statements the store issues. */
  function fakeSql(): {
    sql: SqlExec;
    rows: Map<string, Record<string, unknown>>;
  } {
    const rows = new Map<string, Record<string, unknown>>();

    function upsert(params: unknown[]): void {
      const slug = params[0] as string;
      const existing = rows.get(slug);
      rows.set(slug, {
        slug,
        credential_hashes: params[1],
        worker_hash: params[2],
        client_files: params[3],
        version: existing ? Number(existing.version) + 1 : 1,
      });
    }

    // postgres.js — the one driver in this repo — parses jsonb columns to objects.
    function toResultRow(row: Record<string, unknown>): Record<string, unknown> {
      return {
        ...row,
        credential_hashes: JSON.parse(row.credential_hashes as string),
        client_files: JSON.parse(row.client_files as string),
      };
    }

    const sql: SqlExec = (query, params = []) => {
      if (query.startsWith("create")) return Promise.resolve([]);
      if (query.startsWith("insert")) {
        upsert(params);
        return Promise.resolve([]);
      }
      const slug = params[0] as string;
      if (query.startsWith("delete")) {
        rows.delete(slug);
        return Promise.resolve([]);
      }
      const row = rows.get(slug);
      if (!row) return Promise.resolve([]);
      if (query.includes("select version")) return Promise.resolve([{ version: row.version }]);
      return Promise.resolve([toResultRow(row)]);
    };
    return { sql, rows };
  }

  test("put/get round-trips every jsonb column, and delete clears both reads", async () => {
    const { sql } = fakeSql();
    const store = createPgAgentRows(sql);

    await store.put(RECORD);
    const record = await store.get("my-agent");
    expect(record?.slug).toBe("my-agent");
    expect(record?.credential_hashes).toEqual(["h1"]);
    expect(record?.client_files).toEqual({ "index.html": "def456" });
    expect(record?.version).toBe(1);

    await store.put({ ...RECORD, worker_hash: "v2" });
    expect(await store.getVersion("my-agent")).toBe(2);

    await store.delete("my-agent");
    expect(await store.get("my-agent")).toBeNull();
    expect(await store.getVersion("my-agent")).toBeNull();
  });

  test("a bigint-ish version string is coerced to a number", async () => {
    const { sql, rows } = fakeSql();
    const store = createPgAgentRows(sql);
    await store.put(RECORD);
    const row = rows.get("my-agent");
    if (row) row.version = "7"; // pg returns bigint as text
    expect(await store.getVersion("my-agent")).toBe(7);
    expect((await store.get("my-agent"))?.version).toBe(7);
  });

  test("a corrupt row throws rather than reading as missing", async () => {
    // "Missing" reaches verifySlugOwner as "unclaimed" — the one state where
    // any API key may claim the slug — so a corrupt row must fail closed.
    // The row carries no agent description at all now, so the corruptible
    // columns are the structural ones the host really reads.
    const { sql, rows } = fakeSql();
    const store = createPgAgentRows(sql);
    await store.put(RECORD);
    const row = rows.get("my-agent");
    if (row) row.credential_hashes = JSON.stringify("not an array");
    await expect(store.get("my-agent")).rejects.toThrow("Corrupt agent record");
  });
});
