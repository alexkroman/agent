// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createMemoryAgentRows, createPgAgentRows } from "./agent-store.ts";
import type { SqlExec } from "./secret-store.ts";
import { TEST_AGENT_CONFIG } from "./test-utils.ts";

const RECORD = {
  slug: "my-agent",
  credential_hashes: ["h1"],
  config: { ...TEST_AGENT_CONFIG },
  worker_hash: "abc123",
  client_files: { "index.html": "def456" },
};

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
  function fakeSql(opts: { parsedJson?: boolean } = {}): {
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
        config: params[2],
        worker_hash: params[3],
        client_files: params[4],
        version: existing ? Number(existing.version) + 1 : 1,
      });
    }

    // pg parses jsonb columns to objects; some drivers return text.
    function toResultRow(row: Record<string, unknown>): Record<string, unknown> {
      if (!opts.parsedJson) return row;
      return {
        ...row,
        credential_hashes: JSON.parse(row.credential_hashes as string),
        config: JSON.parse(row.config as string),
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

  test.each([{ parsedJson: true }, { parsedJson: false }])(
    "put/get round-trip (driver returns jsonb %o)",
    async (opts) => {
      const { sql } = fakeSql(opts);
      const store = createPgAgentRows(sql);

      await store.put(RECORD);
      const record = await store.get("my-agent");
      expect(record?.slug).toBe("my-agent");
      expect(record?.credential_hashes).toEqual(["h1"]);
      expect(record?.config.name).toBe(TEST_AGENT_CONFIG.name);
      expect(record?.client_files).toEqual({ "index.html": "def456" });
      expect(record?.version).toBe(1);

      await store.put({ ...RECORD, worker_hash: "v2" });
      expect(await store.getVersion("my-agent")).toBe(2);

      await store.delete("my-agent");
      expect(await store.get("my-agent")).toBeNull();
      expect(await store.getVersion("my-agent")).toBeNull();
    },
  );

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
    const { sql, rows } = fakeSql();
    const store = createPgAgentRows(sql);
    await store.put(RECORD);
    const row = rows.get("my-agent");
    if (row) row.config = JSON.stringify({ not: "a config" });
    await expect(store.get("my-agent")).rejects.toThrow("Corrupt agent record");
  });

  // Stored configs are validated strictly ONCE, at deploy time. Reads must
  // never re-run the current IsolateConfigSchema: a schema tightening would
  // silently turn every previously-valid deployed agent into a 404. Only
  // what the host actually consumes (name, greeting) is asserted; the rest —
  // including shapes today's rules would reject — passes through untouched.
  test("a stored config the CURRENT strict schema would reject still loads", async () => {
    const { sql } = fakeSql();
    const store = createPgAgentRows(sql);
    await store.put({
      ...RECORD,
      config: {
        name: "old-agent",
        greeting: "hi",
        // An incomplete provider triple — IsolateConfigSchema rejects this
        // ("stt, llm, and tts must be set together"), but a pre-tightening
        // deploy could legitimately have stored it.
        stt: { kind: "assemblyai", options: {} },
        // A field no current schema knows.
        someFutureOrRemovedField: { nested: true },
      },
    });
    const record = await store.get("my-agent");
    expect(record).not.toBeNull();
    expect(record?.config.name).toBe("old-agent");
    expect(record?.config.greeting).toBe("hi");
    // Opaque passthrough: unknown/legacy fields survive the round trip.
    expect(record?.config.someFutureOrRemovedField).toEqual({ nested: true });
  });
});
