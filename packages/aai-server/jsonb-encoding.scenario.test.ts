// Copyright 2026 the AAI authors. MIT license.
/**
 * Do the platform's jsonb columns actually contain jsonb?
 *
 * They did not. Every store binds its document as JSON text with a `::jsonb`
 * cast, and postgres.js resolves the parameter's type from that cast and
 * JSON-encodes the string we had already encoded — so the column held a jsonb
 * *string* rather than an object. Two failures came out of it, and the gap
 * between them is the reason this file exists:
 *
 * - `WorkspaceStore.patch` (`doc - text[]`) threw **`cannot delete from
 *   scalar`** in production, breaking every metadata stamp — preview deploys,
 *   Publish, the database toggle.
 * - The orphan-preview pg_cron sweep skips an agent some workspace still names,
 *   via `doc->>'previewSlug'`. That reads NULL out of a string, so the guard
 *   matched nothing and the sweep deleted LIVE previews on the hour.
 *
 * **No unit test could have caught either, and that is the point.** Dev and
 * tests run the in-memory stores (`createMemoryWorkspaceStore` and friends),
 * which model the API faithfully and the ENCODING not at all — they hold JS
 * objects, so a doubly-encoded write is unrepresentable in them. The bug lives
 * strictly in the driver↔Postgres seam, so only a real Postgres can see it.
 *
 * Read-mostly and self-cleaning: everything is written under a `scope`/`slug`
 * prefix this file owns and deleted afterwards, so it is safe against a shared
 * database (but see the write caveat — do NOT point it at production).
 *
 * ```sh
 * AAI_TEST_PG_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
 *   pnpm --filter aai-server test:scenario
 * ```
 *
 * (`pnpm test:pg` resolves a local database and runs the whole tier for you.
 * This package declares no `check:integration` — every slow suite it owns is a
 * SCENARIO one, and `AAI_REQUIRE_PG` is declared under `check:scenario` in
 * `turbo.json`.)
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { createPgChatStore } from "./chat-store.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import { createPgWorkspaceStore } from "./workspace-store.ts";

const SCOPE = "jsonb-encoding-test";

describeWithPg("platform jsonb columns hold jsonb, not strings", () => {
  let db: ReturnType<typeof createPostgresDb>;
  let sql: <T = Record<string, unknown>>(q: string, p?: unknown[]) => Promise<T[]>;

  beforeAll(async () => {
    db = createPostgresDb({ url: pgUrl() });
    sql = db.query;
    // CI's Postgres is the runner's own cluster with no `aai_platform` schema;
    // a no-op against the local Supabase stack or any real database.
    await ensurePlatformTables(sql);
  });

  afterAll(async () => {
    await sql("delete from aai_platform.studio_workspaces where scope = $1", [SCOPE]);
    await sql("delete from aai_platform.studio_chats where scope = $1", [SCOPE]);
    await db.close();
  });

  /** `jsonb_typeof` of one column — the whole question, in one word. */
  async function typeOf(table: string, column: string, project: string): Promise<string> {
    const rows = await sql<{ t: string }>(
      `select jsonb_typeof(${column}) as t from aai_platform.${table}
       where scope = $1 and project = $2`,
      [SCOPE, project],
    );
    return rows[0]?.t ?? "(no row)";
  }

  test("a workspace document is stored as an object", async () => {
    const store = createPgWorkspaceStore(sql);
    await store.put(SCOPE, "shape", { files: {}, previewSlug: "shape-preview" }, null);
    // 'string' is the bug: the driver JSON-encodes an already-encoded document
    // when the parameter's type comes from a bare `::jsonb` cast.
    expect(await typeOf("studio_workspaces", "doc", "shape")).toBe("object");
  });

  test("a chat is stored as an array", async () => {
    // The parent workspace FIRST — `studio_chats_workspace_fk`
    // (`20260810010000_workspace_child_foreign_keys.sql`) makes a chat with no
    // workspace unrepresentable, which is the shape production has. This test
    // wrote the chat alone and was green for as long as the only real arm was a
    // stock Postgres built by `ensurePlatformTables`, whose replay is
    // deliberately partial: the FK lives in a `do $$` block, and only
    // `create table` plus `add`/`drop column` are replayed. So the assertion
    // held against a schema laxer than the migration's — the same class of gap
    // as the double-encode this file exists for, one rung further out.
    await createPgWorkspaceStore(sql).put(SCOPE, "chat", { files: {} }, null);
    const store = createPgChatStore(sql);
    await store.putChat(SCOPE, "chat", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ]);
    expect(await typeOf("studio_chats", "messages", "chat")).toBe("array");
  });

  test("patch stamps metadata instead of `cannot delete from scalar`", async () => {
    const store = createPgWorkspaceStore(sql);
    await store.put(SCOPE, "stamp", { files: {}, previewError: "old" }, null);
    // The failure path first: a settled deploy failure stamps with an EMPTY
    // `remove`, which is the shape production was throwing on.
    const failed = await store.patch(SCOPE, "stamp", { set: { previewError: "boom" } });
    expect(failed?.doc).toMatchObject({ previewError: "boom" });
    // Then the success path, which removes the key it just set.
    const ok = await store.patch(SCOPE, "stamp", {
      set: { previewHash: "h1" },
      remove: ["previewError"],
    });
    expect(ok?.doc).toMatchObject({ previewHash: "h1" });
    expect(ok?.doc).not.toHaveProperty("previewError");
  });

  test("the orphan-preview sweep can see which slug a workspace claims", async () => {
    // The sweep deletes a `-preview` agent only when NO workspace names it,
    // joining `preview_slug` — a STORED generated column over
    // `doc->>'previewSlug'`. The generation expression is the same arrow, so it
    // inherits the same failure: against a string-encoded doc it computes NULL
    // for every row, the guard matches nothing, and previews in use are deleted.
    const store = createPgWorkspaceStore(sql);
    await store.put(SCOPE, "claim", { files: {}, previewSlug: "claim-preview" }, null);
    const rows = await sql<{ claimed: boolean }>(
      `select exists (
         select 1 from aai_platform.studio_workspaces w
         where w.preview_slug = $1
       ) as claimed`,
      ["claim-preview"],
    );
    expect(rows[0]?.claimed).toBe(true);
  });
});
