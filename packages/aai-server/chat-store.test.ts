// Copyright 2026 the AAI authors. MIT license.
// ChatStore: SQL shapes of the Postgres implementation (via a fake SqlExec
// backed by a Map), behavioral parity between the pg and memory stores, and
// the byte-budget trim that keeps a chat row from growing unboundedly.

import { describe, expect, test } from "vitest";
import {
  createMemoryChatStore,
  createPgChatStore,
  MAX_STUDIO_CHAT_STORE_BYTES,
  trimChatToByteBudget,
} from "./chat-store.ts";
import { chatStoreConformance } from "./store-conformance-cases.ts";
import {
  createDispatchingSql,
  createRecordingSql,
  refusingDdl,
  type SqlHandler,
} from "./test-utils.ts";

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
  const rows = new Map<string, string>();
  const key = (scope: unknown, project: unknown) => `${scope} ${project}`;

  const ddl = refusingDdl(opts.failEnsures);
  const selectRow: SqlHandler = ([scope, project]) => {
    const row = rows.get(key(scope, project));
    return row === undefined ? [] : [{ messages: row }];
  };
  const upsertRow: SqlHandler = ([scope, project, messages]) => {
    rows.set(key(scope, project), String(messages));
    return [];
  };
  const deleteRow: SqlHandler = ([scope, project]) => {
    rows.delete(key(scope, project));
    return [];
  };

  return createDispatchingSql([
    ["create schema", ddl],
    ["create table", ddl],
    ["select messages", selectRow],
    ["insert into", upsertRow],
    ["delete", deleteRow],
  ]);
}

// ── The CONTRACT, over the arm that runs everywhere ─────────────────────────
//
// See the same block in `workspace-store.test.ts`: one case list in
// `store-conformance.ts`, the memory arm unconditional here, the stack arm in
// `store-conformance.scenario.test.ts`, and the fake SqlExec back in its own
// recorder spec below rather than posing as a `postgres` implementation.
//
// The memory arm has no `studio_chats_workspace_fk`, so its `parent` is a no-op;
// the stack arm creates the workspace a chat hangs off. Passing the parent in
// keeps the cases identical rather than branching inside them.

describe("ChatStore conformance: memory", () => {
  chatStoreConformance(() => createMemoryChatStore());
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
  /**
   * The table is declared in supabase/migrations, applied before any code
   * runs. A store that issues DDL is the regression: it papers over a missed
   * migration and creates the table under whatever connection first noticed.
   */
  test("issues no DDL — the schema comes from migrations", async () => {
    const { sql, log } = createFakeSql();
    const store = createPgChatStore(sql);
    await store.putChat("s", "p", [msg("m1")]);
    await store.getChat("s", "p");
    expect(log.filter((entry) => /^\s*(create|alter)/i.test(entry.query))).toEqual([]);
  });

  test("putChat is an upsert with the messages bound as jsonb", async () => {
    const { sql, log } = createFakeSql();
    await createPgChatStore(sql).putChat("s", "p", [msg("m1")]);
    const insert = log.find((entry) => entry.query.includes("insert into"));
    expect(insert?.query).toContain("aai_platform.studio_chats");
    // `::text::jsonb`: a bare `$3::jsonb` makes the driver double-encode, so
    // the column holds a jsonb string. See workspace-store.ts.
    expect(insert?.query).toContain("$3::text::jsonb");
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
    const { sql } = createRecordingSql((query) =>
      query.includes("select messages") ? [{ messages: [msg("m1")] }] : [],
    );
    expect(await createPgChatStore(sql).getChat("s", "p")).toEqual([msg("m1")]);
  });

  test("a malformed stored value reads as null, not a crash", async () => {
    const { sql } = createRecordingSql((query) =>
      query.includes("select messages") ? [{ messages: { not: "an array" } }] : [],
    );
    expect(await createPgChatStore(sql).getChat("s", "p")).toBeNull();
  });
});
