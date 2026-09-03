// Copyright 2026 the AAI authors. MIT license.
/**
 * Every store contract, against the ONE arm the platform really runs on.
 *
 * The case lists are `store-conformance.ts` and
 * `aai-studio-server/studio-store-conformance.ts` — the same ones the unit
 * suites run over their memory arms. That is the whole point: a contract is
 * asserted ONCE, and the two arms cannot drift, because there is nothing to
 * drift between. Before this, `agent-store.test.ts` had two separate `describe`s
 * asserting different things and `platform-schema.scenario.test.ts` asserted a
 * THIRD set against real Postgres — three spec sets over one contract, free to
 * disagree and silent about it because each was internally green.
 *
 * **Gated on the STACK, not on a database**, and that distinction is the reason
 * this file exists rather than another `describeWithPg` suite. Vault, pgmq,
 * pg_cron and walrus are Supabase's; nothing anywhere runs `aai_platform`
 * without them, so a stock Postgres is a deployment nobody has and an arm for
 * it would be one more shape production never had. `describeWithStack`
 * announces its own absence loudly, because with no fallback arm that gate is
 * the only thing between "the platform tier ran" and "the platform tier was
 * absent".
 *
 * ```sh
 * supabase start     # applies supabase/migrations on init
 * pnpm test:pg       # resolves the stack, then runs this tier against it
 * ```
 *
 * Writes under keys it owns (every case takes a fresh `conf-*` scope from
 * `uniqueKeys`) and sweeps them in `afterAll`, so it is safe against a shared
 * scratch database. Never point it at production.
 */

import { sleep } from "@alexkroman1/aai/internal";
import type { CloseableDb } from "@alexkroman1/aai-runtime";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { describeWithStack, pgUrl } from "./_pg-test-utils.ts";
import { createPgAgentRows } from "./agent-store.ts";
import { createPgChatStore } from "./chat-store.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import { createPgRateLimiter } from "./rate-limit.ts";
import { createVaultSecretStore, type SqlExec } from "./secret-store.ts";
import { CONFORMANCE_PREFIX, conformanceLike } from "./store-conformance.ts";
import {
  agentRowsConformance,
  chatStoreConformance,
  rateLimiterConformance,
  secretStoreConformance,
  workspaceStoreConformance,
} from "./store-conformance-cases.ts";
import { createPgWorkspaceStore } from "./workspace-store.ts";

describeWithStack("store conformance: the Supabase stack arm", () => {
  let db: CloseableDb;
  let sql: SqlExec;

  beforeAll(async () => {
    // `pgUrl()` inside the hook, never at the top of this body: vitest EXECUTES
    // a `describe.skip` callback to enumerate what it is skipping, so up there it
    // throws during collection instead of skipping the file.
    db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (query, params) => db.query(query, params);
    // Reports a stale stack as a sentence naming the pending migrations, rather
    // than letting the first case die on a column that a migration added.
    await ensurePlatformTables(sql);
  });

  afterAll(async () => {
    // Everything this file writes carries THIS PROCESS's prefix, and the sweep
    // matches nothing else — `conf-%` reached the studio package's suite, which
    // runs in parallel against this same database. See `CONFORMANCE_PREFIX`.
    // Workspaces cascade to their chats and sessions (`on delete cascade`), so
    // the workspace sweep covers three tables; agents, rate-limit rows and Vault
    // secrets are their own.
    const mine = conformanceLike();
    await sql("delete from aai_platform.studio_workspaces where scope like $1", [mine]);
    await sql("delete from aai_platform.agents where slug like $1", [mine]);
    await sql("delete from aai_platform.studio_rate_limits where key like $1", [mine]);
    await sql("select vault.delete_secret(name) from vault.decrypted_secrets where name like $1", [
      mine,
    ]).catch(async () => {
      // Older Vault has no `delete_secret`; the store's own delete is the
      // fallback and does the same thing one row at a time.
      const rows = await sql("select name from vault.decrypted_secrets where name like $1", [mine]);
      const store = createVaultSecretStore(sql);
      for (const row of rows) await store.delete(String(row.name));
    });
    await db?.close();
  });

  /**
   * The workspace a child row hangs off.
   *
   * `studio_chats_workspace_fk` and the sessions key make a parentless child
   * unrepresentable, which is the shape production has — and the shape the
   * memory arms cannot express, so the cases take the parent as a parameter
   * rather than branching on which arm they are running under.
   */
  const parent = async (scope: string, project: string): Promise<void> => {
    await createPgWorkspaceStore(sql).put(scope, project, { files: {} }, null);
  };

  describe("WorkspaceStore", () => {
    workspaceStoreConformance(() => createPgWorkspaceStore(sql));
  });

  describe("ChatStore", () => {
    chatStoreConformance(() => createPgChatStore(sql), parent);
  });

  describe("AgentRows", () => {
    agentRowsConformance(() => createPgAgentRows(sql));
  });

  describe("SecretStore (Vault)", () => {
    // The first contract that could not have had a real arm at all before the
    // stack was resolvable: `create_secret`, `decrypted_secrets`, `update_secret`
    // and the `23505` retry are all `supabase_vault`, which no stock server has.
    secretStoreConformance(() => createVaultSecretStore(sql));
  });

  describe("RateLimiter", () => {
    // An abuse control is worthless if it is not ATOMIC, and only a real database
    // can say whether the upsert is. The `name` namespaces this limiter's rows,
    // so it shares the table with production names without colliding.
    rateLimiterConformance((opts) => createPgRateLimiter(sql, { name: "conformance", ...opts }));

    test("a window that has elapsed starts a fresh count", async () => {
      // Real elapsed time, because this arm's clock is the DATABASE's: it drops
      // the `now` the interface offers, on purpose (see `RateLimiter.check`), so
      // the window can only be observed by waiting one out. Cheap here — a 300ms
      // window — and impossible to express in the shared case list, which is the
      // finding rather than an inconvenience.
      const limiter = createPgRateLimiter(sql, { name: "conformance", limit: 1, windowMs: 300 });
      const key = `${CONFORMANCE_PREFIX}rl-elapsed-${Date.now()}`;
      expect(await limiter.check(key)).toEqual({ ok: true });
      expect((await limiter.check(key)).ok).toBe(false);
      await sleep(400);
      expect(await limiter.check(key)).toEqual({ ok: true });
    });
  });

  // The studio's two contracts (session registry, preview queue) run their stack
  // arm in `aai-studio-server`, not here: this package may not import that one —
  // the dependency runs the other way — and their TYPES live there. Same case
  // lists, same gate (re-exported through `./test-utils` so a sibling can reach
  // it), one tier over.
});
