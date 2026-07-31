// Copyright 2026 the AAI authors. MIT license.
// ChatStore: SQL shapes of the Postgres implementation (via a fake SqlExec
// backed by a Map), behavioral parity between the pg and memory stores, and
// the byte-budget trim that keeps a chat row from growing unboundedly.

import { describe, expect, test } from "vitest";
import type { SqlExec } from "../secret-store.ts";
import {
  type ChatStore,
  createMemoryChatStore,
  createPgChatStore,
  MAX_STUDIO_CHAT_STORE_BYTES,
  trimChatToByteBudget,
} from "./chat-store.ts";

function msg(id: string, text = "hi"): Record<string, unknown> {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

/**
 * Fake SqlExec implementing the store's statements over a Map, keeping a log
 * of every statement for shape assertions. Messages are stored (and
 * returned) as the bound JSON string, which also exercises the store's
 * string-column parse branch.
 */
function createFakeSql(opts: { failEnsures?: number } = {}) {
  type Handler = (params: unknown[]) => Record<string, unknown>[];
  const rows = new Map<string, string>();
  const log: { query: string; params: unknown[] }[] = [];
  let ensureFailures = opts.failEnsures ?? 0;
  const key = (scope: unknown, project: unknown) => `${scope} ${project}`;

  const ddl: Handler = () => {
    if (ensureFailures > 0) {
      ensureFailures -= 1;
      throw new Error("ddl refused");
    }
    return [];
  };
  const selectRow: Handler = ([scope, project]) => {
    const row = rows.get(key(scope, project));
    return row === undefined ? [] : [{ messages: row }];
  };
  const upsertRow: Handler = ([scope, project, messages]) => {
    rows.set(key(scope, project), String(messages));
    return [];
  };
  const deleteRow: Handler = ([scope, project]) => {
    rows.delete(key(scope, project));
    return [];
  };
  const handlers: [string, Handler][] = [
    ["create schema", ddl],
    ["create table", ddl],
    ["select messages", selectRow],
    ["insert into", upsertRow],
    ["delete", deleteRow],
  ];

  const sql: SqlExec = (query, params = []) => {
    log.push({ query, params });
    const q = query.replace(/\s+/g, " ").trim().toLowerCase();
    const handler = handlers.find(([prefix]) => q.startsWith(prefix))?.[1];
    if (!handler) return Promise.reject(new Error(`Unexpected query: ${query}`));
    try {
      return Promise.resolve(handler(params));
    } catch (err) {
      return Promise.reject(err);
    }
  };

  return { sql, log };
}

// ── Behavioral parity: both implementations must agree ─────────────────────

const implementations: [string, () => ChatStore][] = [
  ["memory", () => createMemoryChatStore()],
  ["postgres (fake SqlExec)", () => createPgChatStore(createFakeSql().sql)],
];

describe.each(implementations)("ChatStore parity: %s", (_name, make) => {
  test("getChat returns null for a project with no chat", async () => {
    expect(await make().getChat("s", "ghost")).toBeNull();
  });

  test("putChat + getChat round-trips the message list", async () => {
    const store = make();
    await store.putChat("s", "p", [msg("m1"), msg("m2")]);
    expect(await store.getChat("s", "p")).toEqual([msg("m1"), msg("m2")]);
  });

  test("putChat is a plain upsert — the row is always the latest snapshot", async () => {
    const store = make();
    await store.putChat("s", "p", [msg("m1")]);
    await store.putChat("s", "p", [msg("m1"), msg("m2"), msg("m3")]);
    expect(await store.getChat("s", "p")).toEqual([msg("m1"), msg("m2"), msg("m3")]);
  });

  test("chats are scoped: same project name under two scopes stays separate", async () => {
    const store = make();
    await store.putChat("s1", "p", [msg("mine")]);
    await store.putChat("s2", "p", [msg("theirs")]);
    expect(await store.getChat("s1", "p")).toEqual([msg("mine")]);
    expect(await store.getChat("s2", "p")).toEqual([msg("theirs")]);
  });

  test("deleteChat removes the row and is idempotent", async () => {
    const store = make();
    await store.putChat("s", "p", [msg("m1")]);
    await store.deleteChat("s", "p");
    expect(await store.getChat("s", "p")).toBeNull();
    await store.deleteChat("s", "p"); // no throw
  });

  test("an oversized conversation is trimmed from the front on write", async () => {
    const store = make();
    const big = "x".repeat(200 * 1024);
    const messages = [msg("m1", big), msg("m2", big), msg("m3", big), msg("m4", "recent")];
    await store.putChat("s", "p", messages);
    const stored = (await store.getChat("s", "p")) as { id: string }[];
    // Whole oldest messages dropped; the newest survive intact.
    expect(stored.at(-1)?.id).toBe("m4");
    expect(stored.length).toBeLessThan(messages.length);
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThanOrEqual(
      MAX_STUDIO_CHAT_STORE_BYTES,
    );
  });
});

test("memory store never shares mutable state with callers", async () => {
  const store = createMemoryChatStore();
  const messages = [msg("m1")];
  await store.putChat("s", "p", messages);
  (messages[0] as { id: string }).id = "mutated-after-put";
  const read = (await store.getChat("s", "p")) as { id: string }[];
  expect(read[0]?.id).toBe("m1");
  read[0] = { id: "mutated-after-get" };
  expect(((await store.getChat("s", "p")) as { id: string }[])[0]?.id).toBe("m1");
});

// ── trimChatToByteBudget ────────────────────────────────────────────────────

describe("trimChatToByteBudget", () => {
  test("returns the same list when it fits", () => {
    const messages = [msg("m1"), msg("m2")];
    expect(trimChatToByteBudget(messages)).toBe(messages);
  });

  test("drops whole messages from the front, never truncating one", () => {
    const messages = [msg("old"), msg("mid"), msg("new")];
    const budget = Buffer.byteLength(JSON.stringify([msg("mid"), msg("new")])) + 2;
    expect(trimChatToByteBudget(messages, budget)).toEqual([msg("mid"), msg("new")]);
  });

  test("a newest message that alone exceeds the budget yields an empty list", () => {
    expect(trimChatToByteBudget([msg("m1", "x".repeat(100))], 50)).toEqual([]);
  });

  test("the trimmed result serializes within the budget", () => {
    const messages = Array.from({ length: 50 }, (_, i) => msg(`m${i}`, "y".repeat(64 * 1024)));
    const trimmed = trimChatToByteBudget(messages);
    expect(trimmed.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(trimmed))).toBeLessThanOrEqual(
      MAX_STUDIO_CHAT_STORE_BYTES,
    );
    // Recency wins: the kept messages are the tail of the original list.
    expect(trimmed.at(-1)).toEqual(messages.at(-1));
  });
});

// ── Postgres SQL shapes ─────────────────────────────────────────────────────

describe("createPgChatStore SQL", () => {
  test("lazily creates the aai_platform schema and table exactly once", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgChatStore(sql);
    await store.putChat("s", "p", [msg("m1")]);
    await store.getChat("s", "p");
    const ddl = log.filter((entry) => entry.query.startsWith("create"));
    expect(ddl.map((entry) => entry.query)).toEqual([
      "create schema if not exists aai_platform",
      expect.stringContaining("create table if not exists aai_platform.studio_chats"),
    ]);
    expect(ddl[1]?.query).toContain("messages jsonb not null");
    // No version column: the row is a full snapshot with one writer surface.
    expect(ddl[1]?.query).not.toContain("version");
    expect(ddl[1]?.query).toContain("primary key (scope, project)");
  });

  test("a failed ensure is retried on the next call, not memoized", async () => {
    const { sql } = createFakeSql({ failEnsures: 1 });
    const store = createPgChatStore(sql);
    await expect(store.getChat("s", "p")).rejects.toThrow("ddl refused");
    expect(await store.getChat("s", "p")).toBeNull();
  });

  test("putChat is an upsert with the messages bound as jsonb", async () => {
    const { sql, log } = createFakeSql();
    await createPgChatStore(sql).putChat("s", "p", [msg("m1")]);
    const insert = log.find((entry) => entry.query.includes("insert into"));
    expect(insert?.query).toContain("aai_platform.studio_chats");
    expect(insert?.query).toContain("$3::jsonb");
    expect(insert?.query).toContain(
      "on conflict (scope, project) do update set messages = excluded.messages, updated_at = now()",
    );
    expect(insert?.params).toEqual(["s", "p", JSON.stringify([msg("m1")])]);
  });

  test("getChat/deleteChat bind scope and project as parameters", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgChatStore(sql);
    await store.getChat("sc", "pr");
    await store.deleteChat("sc", "pr");
    const [get, del] = log.filter((entry) => !entry.query.startsWith("create"));
    expect(get).toEqual({
      query: expect.stringContaining("select messages"),
      params: ["sc", "pr"],
    });
    expect(del).toEqual({ query: expect.stringContaining("delete from"), params: ["sc", "pr"] });
  });

  test("reads accept a jsonb column that arrives pre-parsed", async () => {
    const sql: SqlExec = (query) =>
      Promise.resolve(query.includes("select messages") ? [{ messages: [msg("m1")] }] : []);
    expect(await createPgChatStore(sql).getChat("s", "p")).toEqual([msg("m1")]);
  });

  test("a malformed stored value reads as null, not a crash", async () => {
    const sql: SqlExec = (query) =>
      Promise.resolve(query.includes("select messages") ? [{ messages: { not: "an array" } }] : []);
    expect(await createPgChatStore(sql).getChat("s", "p")).toBeNull();
  });
});
