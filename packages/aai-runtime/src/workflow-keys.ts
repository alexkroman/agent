// Copyright 2026 the AAI authors. MIT license.
/**
 * The correlation-key index: `(workflow, key) -> runId`.
 *
 * **This is the only piece of workflow storage this SDK still owns**, and it
 * exists because the Workflow Development Kit has no notion of tagging a run.
 * `start()` takes a `deploymentId`, a `specVersion` and a `world` and nothing
 * else; `runs.list()` filters by workflow name and status and nothing else. So
 * "which run belongs to this phone number" is a question WDK cannot be asked.
 *
 * Why that question has to be answerable at all is in
 * `StartOptions.key`'s doc, and it is specifically a VOICE problem: a run
 * outlives the session that started it, while `ctx.state` — the obvious place to
 * keep a `runId` — is swept `SESSION_RESUME_GRACE_MS` after the caller hangs up.
 * Without an index the durable run is unreachable from the next call, which is
 * the case the whole feature is for.
 *
 * Three implementations, because the index has to work in all three places a
 * workflow runs — the same three the run JOURNAL has, and picked by the same
 * preference (`selectKeyStore` in `workflow-runtime.ts`):
 *
 * - **Platform** (`createPlatformKeyStore`, `workflow-keys-platform.ts`) — the
 *   platform's own table, over `POST /:slug/workflow-keys` with the per-sandbox
 *   bearer. This is what a DEPLOYED agent gets, and it is the newest of the three.
 * - **Postgres** (`createPostgresKeyStore`) — a single table in the app's own
 *   database, so it needs no second credential and is reaped with the app. This is
 *   a SELF-HOSTED deployment, or a platform agent whose author supplied a
 *   `DATABASE_URL` as a secret.
 * - **Memory** (`createMemoryKeyStore`) — for `aai dev`, which keeps its own state
 *   in `.workflow-data/` and needs no database. Deliberately NOT durable: a dev
 *   server restart forgets the index, which is the same thing dev mode already
 *   does to the runs themselves, so degrading further would be dishonest about
 *   what dev mode is.
 *
 * **Two claims that used to be in this doc were false, and the second is why the
 * platform arm exists.** It said the Postgres store "is production", and that "a
 * workflow app has storage switched on when it is created" — both written when
 * `ctx.db` existed. The platform provisions no database now
 * (`packages/aai/src/sdk/db.ts`, `aai-server/sandbox-resolve.ts`: `DATABASE_URL` is the
 * AUTHOR's own secret and is usually absent), so on a typical deployed agent the
 * store in production was the MEMORY one — a `Map` in a sandbox that self-exits
 * after `AGENT_IDLE_EXIT_MS`. The run itself was durable, so what died was the only
 * pointer to it: `find()` answered `[]` on the caller's next call and the agent
 * started a second run for somebody it had already served, with nothing reporting
 * it, because an empty index and a first-time caller are the same answer. This is
 * the gap `20260901000000_platform_workflow_journal.sql` closed for the journal,
 * still open one table over.
 *
 * The Postgres table is created lazily and idempotently rather than by a migration
 * step, for the same reason a dev world's `bootstrap` is: an agent's first workflow
 * may be its first ever deploy, and there is no separate provisioning pass to hang
 * a DDL step off. The PLATFORM table is the opposite — one migration
 * (`20260903030000_workflow_run_keys.sql`), applied before any code runs, because
 * that schema serves every agent and no tenant may create anything in it.
 */

import type { Db } from "@alexkroman1/aai/internal";
import { ensureOnce } from "./_ensure-once.ts";
import { getOrCreate } from "./_get-or-create.ts";

/** How many runs a keyed or keyless lookup returns when the caller names no limit. */
export const DEFAULT_WORKFLOW_FIND_LIMIT = 20;
/** Ceiling on `FindOptions.limit`, so one lookup cannot scan a whole history. */
export const MAX_WORKFLOW_FIND_LIMIT = 100;

/** The table the index lives in. Prefixed so it cannot collide with an app's own. */
export const WORKFLOW_KEYS_TABLE = "aai_workflow_run_keys";

/**
 * The index, as the client uses it.
 *
 * `record` is called after a run is created and `lookup` when one is sought. Both
 * take the workflow NAME rather than its `workflowId`, because a name is what
 * survives a redeploy: `workflowId` embeds the source file path, so moving a
 * workflow between modules would orphan every key recorded under the old id.
 */
export type WorkflowKeyStore = {
  /** Note that `runId` was started for `key`. */
  record(workflow: string, key: string, runId: string): Promise<void>;
  /** Run ids started for `key`, newest first, at most `limit`. */
  lookup(workflow: string, key: string, limit: number): Promise<string[]>;
};

/** Clamp a caller's `limit` into the range a single lookup may scan. */
export function resolveFindLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_WORKFLOW_FIND_LIMIT;
  return Math.max(1, Math.min(Math.floor(limit), MAX_WORKFLOW_FIND_LIMIT));
}

/**
 * An index in this process's memory, for `aai dev`.
 *
 * Newest-first is maintained by UNSHIFTING rather than by sorting on read: the
 * ordering contract is "the order they were started", and the only clock
 * available here is the wall clock, whose resolution two `start()` calls in the
 * same millisecond would collapse.
 *
 * **A run id is recorded at most once, which is this store's spelling of the
 * `on conflict … do nothing` both durable stores carry.** See {@link recorded}: it
 * closed two divergences from the stores a deployment really uses, both found by
 * `workflow-keys-conformance.ts` on its first run and both on the path that
 * clause exists for.
 */
export function createMemoryKeyStore(): WorkflowKeyStore {
  const byKey = new Map<string, string[]>();
  /**
   * Every run id this store has recorded, whatever key it was recorded under.
   *
   * FIRST WRITE WINS, which is `on conflict (run_id) do nothing` — the Postgres
   * table keys on `run_id`, so it has this property from its schema and this
   * store had to be told. Three cases in the conformance table failed without
   * it, and each is a different symptom of the same one-line absence:
   *
   * - **A retried `record` after a lost connection LISTED the run twice.** The
   *   unconditional `unshift` below appended a second copy, so one lookup
   *   answered `[r, r]` where a real server answers `[r]` — and a caller reading
   *   two entries as two conversations resumes the same run twice. That retry is
   *   the exact case the Postgres store's own `on conflict` comment names, so
   *   the REFERENCE disagreed with production on the one path the clause is for.
   * - **The retry also MOVED the run.** `unshift` puts it at the front, so a
   *   late retry of an older run promoted it past a newer one and "the newest
   *   run for this caller" answered the wrong one.
   * - **A run recorded under a SECOND key was findable by both.** Postgres keeps
   *   the first key only (`aai-server/workflow-keys.scenario.test.ts` pins it),
   *   where this store indexed the run twice — so `lookup`'s promise, "run ids
   *   started for `key`", answered a run started for a different key.
   *
   * A `Set` rather than a scan of `byKey`, because the alternative is O(every
   * run this process has ever started) per `record`. It grows with `byKey` and
   * dies with it: this store is dev-only and deliberately not durable.
   */
  const recorded = new Set<string>();
  // `\u0000` and NOT a raw NUL byte. A single literal NUL makes the whole file
  // BINARY to `git grep`, which silently exempts it from every guard-invariants
  // line rule and every check-escape-hatches pattern while the corpus floor
  // still counts it. That has now happened twice here (see
  // `host/workflow-notify.ts`), so `assertScanCorpus` diffs `git ls-files`
  // against `git grep -lI` and fails on a third.
  const compositeKey = (workflow: string, key: string): string => `${workflow}\u0000${key}`;
  return {
    record(workflow, key, runId) {
      // A run id already known is a RETRY, not a new fact — see `recorded`. The
      // guard is before the write and returns silently, because a retried
      // `record` must be a no-op rather than an error the tool call surfaces.
      if (recorded.has(runId)) return Promise.resolve();
      recorded.add(runId);
      // Newest first, matching what the Postgres store's `order by ... desc`
      // hands back — `lookup` slices from the front.
      getOrCreate(byKey, compositeKey(workflow, key), () => []).unshift(runId);
      return Promise.resolve();
    },
    lookup(workflow, key, limit) {
      return Promise.resolve((byKey.get(compositeKey(workflow, key)) ?? []).slice(0, limit));
    },
  };
}

/**
 * An index in the workflow database.
 *
 * `run_id` is the primary key rather than `(workflow, key)`: a key is
 * deliberately not unique (see `StartOptions.key`), so keying on the pair
 * would make a second `start` with the same key either fail or silently replace
 * the first — and "the newest run for this caller" is a read, not a write
 * constraint.
 *
 * Ordering is by `created_at` DESC with `run_id` DESC as the tiebreak: run ids
 * are ULIDs, which sort lexicographically by generation time, so two runs
 * recorded in the same millisecond come back in the order they were started
 * instead of in whatever order the planner happened to emit.
 *
 * **The tiebreak and the index are load-bearing TOGETHER, and neither can be
 * simplified by testing the other.** The lookup index below already carries
 * `created_at desc, run_id desc`, so an index-only scan returns the tiebreak
 * whether or not the query asks for it — deleting `, run_id desc` from the
 * `ORDER BY` leaves the deployed happy path passing, which is exactly what the
 * first draft of `aai-server/workflow-keys.scenario.test.ts` discovered. The
 * clause earns its place on any plan that has to SORT instead: a table created
 * by a version predating the index (it is a separate `create index if not
 * exists`), a parallel plan, or a sequential scan. That suite therefore runs the
 * lookup a second time with index scans disabled, and it is that arm which fails
 * when the tiebreak goes.
 */
export function createPostgresKeyStore(db: Db): WorkflowKeyStore {
  /**
   * Create the table once per store.
   *
   * `ensureOnce` owns the memo — see its doc for why it has to be on the
   * PROMISE (concurrent `create table if not exists` on one name take
   * conflicting locks, so a boolean flipped after the await is a deadlock) and
   * why a rejection is not remembered as done.
   */
  const ensureTable = ensureOnce(async () => {
    await db.query(`
      create table if not exists ${WORKFLOW_KEYS_TABLE} (
        run_id text primary key,
        workflow text not null,
        key text not null,
        created_at timestamptz not null default now()
      )
    `);
    // The only query shape this table serves. Without it a lookup on a busy
    // agent degrades to a full scan of every run it has ever started.
    await db.query(`
      create index if not exists ${WORKFLOW_KEYS_TABLE}_lookup
        on ${WORKFLOW_KEYS_TABLE} (workflow, key, created_at desc, run_id desc)
    `);
  });

  return {
    async record(workflow, key, runId) {
      await ensureTable();
      // `on conflict do nothing` rather than an upsert: a run id is already
      // unique, so a conflict means this exact run was recorded twice — a retried
      // `record` after a lost connection, which must be a no-op and not an error
      // the tool call surfaces.
      await db.query(
        `insert into ${WORKFLOW_KEYS_TABLE} (run_id, workflow, key)
         values ($1, $2, $3) on conflict (run_id) do nothing`,
        [runId, workflow, key],
      );
    },
    async lookup(workflow, key, limit) {
      await ensureTable();
      const rows = await db.query<{ run_id: string }>(
        `select run_id from ${WORKFLOW_KEYS_TABLE}
         where workflow = $1 and key = $2
         order by created_at desc, run_id desc
         limit $3`,
        [workflow, key, limit],
      );
      return rows.map((r) => r.run_id);
    },
  };
}
