// Copyright 2026 the AAI authors. MIT license.
/**
 * Durable storage for the two pieces of per-session state a resume needs.
 *
 * A `?sessionId=<id>` reconnect already survives a dropped SOCKET: the
 * runtime keeps `ctx.state` in an in-process map for
 * `SESSION_RESUME_GRACE_MS` (see session-state-sweeps.ts) and the S2S
 * transport keeps the provider's session id in a closure so a transient close
 * can `session.resume`. Both live in the guest PROCESS, so neither survives
 * that process going away — a restarted sandbox answers a resume with a
 * session that is connected and amnesiac, which is worse than an honest
 * disconnect. This module is where that state goes instead.
 *
 * The store is a MIRROR, never the hot path. `getState` keeps returning the
 * live object tools mutate in place, and the runtime writes through to a store
 * behind a coalescing runner (see session-persistence.ts); the store is read
 * exactly once per session, when a resume finds no live entry. So an agent
 * with no store configured runs precisely the code it ran before, and one with
 * a store pays a serialization per settled tool call rather than per mutation.
 *
 * Two implementations ship: {@link createMemorySessionStore} (a Map — process
 * lifetime, useful for `aai dev` and tests) and
 * {@link createDbSessionStore} (Postgres over the same `Db` contract tool code
 * sees as `ctx.db`). Anything satisfying {@link SessionStore} works.
 */

import { SESSION_RESUME_GRACE_MS } from "../sdk/constants.ts";
import type { Db } from "../sdk/db.ts";
import { errorMessage } from "../sdk/utils.ts";

/**
 * What a replacement process needs to rebuild a session the caller is
 * resuming.
 *
 * Deliberately small. It is NOT a session checkpoint: the conversation
 * history is replayed by the client (`history` frame) and the in-flight turn
 * is gone either way, so persisting more would be persisting things no
 * resume can use.
 *
 * @public
 */
export type SessionSnapshot = {
  /**
   * The session's `ctx.state` — whatever the agent's tools put there, as it
   * stood when the snapshot was taken. Must be JSON-serializable; see
   * {@link SessionStore.save}.
   */
  state: Record<string, unknown>;
  /**
   * The PROVIDER's session id (AssemblyAI S2S `session.ready`), which is what
   * lets a replacement process `session.resume` into the same service-side
   * conversation rather than opening a blank one.
   *
   * Absent in pipeline mode, which holds no resumable provider session — its
   * STT/LLM/TTS streams are per-turn.
   */
  providerSessionId?: string;
};

/**
 * Where {@link SessionSnapshot}s live between a disconnect and its resume.
 *
 * Every method may reject; the runtime treats a store failure as "no
 * snapshot" and logs it, because a session that starts fresh is strictly
 * better than one that fails to start.
 *
 * @public
 */
export type SessionStore = {
  /** The snapshot for `sessionId`, or null when there is none (or it expired). */
  load(sessionId: string): Promise<SessionSnapshot | null>;
  /**
   * Write `snapshot` for `sessionId`, replacing any previous one.
   *
   * The caller has already checked that `snapshot.state` survives
   * `JSON.stringify` — an implementation may serialize it without guarding.
   */
  save(sessionId: string, snapshot: SessionSnapshot): Promise<void>;
  /** Drop `sessionId`'s snapshot. Absent is not an error. */
  delete(sessionId: string): Promise<void>;
};

/**
 * A {@link SessionStore} in a plain Map — process lifetime, no dependencies.
 *
 * It does NOT survive a restart, so it buys nothing over the runtime's own
 * map for the case this module exists for. It ships because it makes the
 * seam exercisable without a database: `aai dev` and tests get identical
 * hydration behaviour to production, which is what keeps a resume bug from
 * being reproducible only against Postgres.
 *
 * That parity is why it round-trips through JSON rather than
 * `structuredClone`, which would be the obvious choice and is the wrong one:
 * the two disagree on exactly the values an agent is most likely to put in
 * `ctx.state`. `structuredClone` preserves a `Map`, a `Set` and a cycle that
 * `JSON.stringify` drops or rejects — so a state shape that worked all through
 * local development would come back as `{}` the first time it hit Postgres,
 * with nothing raised at either end.
 *
 * @public
 */
export function createMemorySessionStore(): SessionStore {
  const snapshots = new Map<string, SessionSnapshot>();
  return {
    load: (sessionId) => Promise.resolve(snapshots.get(sessionId) ?? null),
    save: (sessionId, snapshot) => {
      // Snapshot by VALUE, not reference: the live `ctx.state` keeps being
      // mutated after this returns, so holding the caller's object would make
      // every later mutation retroactively part of a snapshot that was
      // supposed to be a point in time — and a missing write would then be
      // untestable, because the value read back is right anyway.
      snapshots.set(sessionId, JSON.parse(JSON.stringify(snapshot)) as SessionSnapshot);
      return Promise.resolve();
    },
    delete: (sessionId) => {
      snapshots.delete(sessionId);
      return Promise.resolve();
    },
  };
}

/** Options for {@link createDbSessionStore}. */
export type CreateDbSessionStoreOptions = {
  /** Where snapshots are written — the app's own database (`ctx.db`'s handle). */
  db: Db;
  /**
   * How long a snapshot outlives its last write before `load` ignores it and
   * the next write sweeps it. Defaults to `SESSION_RESUME_GRACE_MS`, matching
   * the in-process grace window so a store cannot silently extend how long a
   * session is resumable.
   */
  ttlMs?: number;
  /**
   * Table name, unqualified — it lands in the connection's `search_path`,
   * which on the platform is the app's own schema. Defaults to
   * `aai_session_state`.
   */
  table?: string;
};

/** Table name segment: our own default or a caller's, never model input. */
const SAFE_TABLE_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * A {@link SessionStore} backed by Postgres, over the same one-method `Db`
 * contract tool code sees as `ctx.db`.
 *
 * **The table is created lazily, on first use.** That is the opposite of the
 * rule the platform schema follows (declared in `supabase/migrations`, applied
 * before the code that queries it — see `aai-server/CLAUDE.md`), and the
 * difference is that this table lives in a TENANT's per-app schema, which has
 * no migration pipeline: app schemas are provisioned empty and every table in
 * them is created at runtime by the code that uses it. There is no earlier
 * moment to do it in. The DDL is `if not exists` and issued once per store.
 *
 * @public
 */
export function createDbSessionStore(opts: CreateDbSessionStoreOptions): SessionStore {
  const { db } = opts;
  const ttlMs = opts.ttlMs ?? SESSION_RESUME_GRACE_MS;
  const table = opts.table ?? "aai_session_state";
  if (!SAFE_TABLE_RE.test(table)) {
    throw new Error(`Invalid session-store table name: ${table}`);
  }

  /**
   * The one-shot DDL, memoized as a PROMISE so concurrent first calls join it
   * rather than racing two `create table` statements. A rejection is not
   * cached — the next call retries, since the usual cause is a database that
   * was briefly unreachable.
   */
  let ready: Promise<void> | null = null;
  function ensureTable(): Promise<void> {
    ready ??= db
      .query(
        `create table if not exists ${table} (
           session_id text primary key,
           snapshot jsonb not null,
           updated_at timestamptz not null default now()
         )`,
      )
      .then(() => undefined)
      .catch((err: unknown) => {
        ready = null;
        throw err;
      });
    return ready;
  }

  return {
    async load(sessionId) {
      await ensureTable();
      // Age is filtered in SQL rather than after the read: `updated_at` is
      // written by the database's clock, so comparing it against the guest's
      // would make expiry depend on two clocks agreeing — and a replacement
      // sandbox is exactly where they might not.
      const rows = await db.query<{ snapshot: unknown }>(
        `select snapshot from ${table}
          where session_id = $1 and updated_at > now() - ($2 || ' milliseconds')::interval`,
        [sessionId, String(ttlMs)],
      );
      const snapshot = rows[0]?.snapshot;
      if (snapshot === null || typeof snapshot !== "object") return null;
      const { state, providerSessionId } = snapshot as Partial<SessionSnapshot>;
      // A row whose `state` is not an object is a snapshot written by
      // something else (or a hand-edited row): ignore it rather than install
      // a non-object as `ctx.state`, where every tool would then see it.
      if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
      return {
        state,
        ...(typeof providerSessionId === "string" ? { providerSessionId } : {}),
      };
    },

    async save(sessionId, snapshot) {
      await ensureTable();
      await db.query(
        `insert into ${table} (session_id, snapshot, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (session_id)
         do update set snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
        [sessionId, JSON.stringify(snapshot)],
      );
      // Opportunistic sweep, on the write path because there is no scheduler
      // in a guest that is meant to exit when idle. Failures are swallowed:
      // an unswept row is a row `load` already ignores, so losing this must
      // never fail the write that carries it.
      await db
        .query(
          `delete from ${table} where updated_at < now() - ($1 || ' milliseconds')::interval`,
          [String(ttlMs)],
        )
        .catch(() => undefined);
    },

    async delete(sessionId) {
      await ensureTable();
      await db.query(`delete from ${table} where session_id = $1`, [sessionId]);
    },
  };
}

/**
 * Serialize a snapshot, or say why it cannot be.
 *
 * `ctx.state` is whatever an agent's tools put there, so it can hold a value
 * `JSON.stringify` REFUSES — a cycle, a BigInt, a `toJSON` that throws. On the
 * write path that throw would propagate out of a tool call's `finally`, taking
 * down a turn over bookkeeping the caller never asked for. Answering with a
 * reason instead lets the runtime log once and leave the session un-persisted,
 * which degrades to exactly the behaviour it had before any store existed.
 *
 * The result doubles as the writer's dedupe key, which is why this returns the
 * JSON rather than a bare verdict: a tool call that changed nothing (most of
 * them do not touch state) then costs no write at all.
 *
 * **It does not catch a silent DROP**, and nothing cheap does: `JSON.stringify`
 * turns a `Map` or a `Set` into `{}` and omits a function-valued property
 * without complaint, so such a snapshot round-trips as a structurally different
 * object. Detecting that means deep-comparing the round-trip on every save, on
 * a path that runs per tool call, to catch a shape that is already ill-advised
 * in state meant to outlive a process. The contract is the mitigation:
 * {@link SessionSnapshot} requires JSON-serializable state, and both shipped
 * stores agree on what that means (see {@link createMemorySessionStore}).
 *
 * @internal
 */
export function serializeSnapshot(snapshot: SessionSnapshot): { json: string } | { error: string } {
  let json: string | undefined;
  try {
    json = JSON.stringify(snapshot);
  } catch (err) {
    return { error: errorMessage(err) };
  }
  // `undefined` rather than a throw is what `JSON.stringify` returns for a
  // top-level value it cannot represent at all.
  return json === undefined ? { error: "snapshot is not JSON-serializable" } : { json };
}
