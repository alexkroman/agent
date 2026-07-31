// Copyright 2026 the AAI authors. MIT license.
/**
 * Persistence for cross-replica session resume.
 *
 * A disconnected session's client may reconnect with `?sessionId=<id>`
 * within the resume grace window ({@link SESSION_RESUME_GRACE_MS}). On the
 * same replica the state is still in process (guest ctx.state behind the
 * deferred `session/end`, `remember` notes in the host's session-notes map),
 * but the platform proxy is free to route the reconnect to a different
 * replica — which used to mean a fresh session behind a continuous-looking
 * transcript. This store closes that gap: on disconnect the sandbox
 * persists the session's resumable state here (see sandbox.ts), and a
 * resume on any replica hydrates from it.
 *
 * Conversation history deliberately does NOT live here — the browser client
 * replays it on reconnect (the `history` frame → `transport.seedHistory`),
 * which already works cross-replica.
 *
 * Rows are keyed by sessionId but scoped to the agent's slug: session ids
 * appear in client URLs, so a resume for agent A must never hydrate state
 * persisted by agent B. Same two-implementation pattern as the other
 * platform stores — Postgres (`aai_platform.session_state`) in production,
 * memory for dev/tests.
 */

import { SESSION_RESUME_GRACE_MS } from "@alexkroman1/aai";
import { z } from "zod";
import { ensureTableOnce } from "./pg-ensure.ts";
import type { SqlExec } from "./secret-store.ts";

/** What a resumed session needs back. Both halves optional — either may be empty. */
export type SessionResumeState = {
  /** Guest-side ctx.state (custom tools). */
  state?: Record<string, unknown> | undefined;
  /** Host-side `remember`/`recall` notes. */
  notes?: Record<string, string> | undefined;
};

export type SessionStateStore = {
  /** Persist a disconnected session's resumable state (upsert). */
  save(slug: string, sessionId: string, data: SessionResumeState): Promise<void>;
  /** Load unexpired state for a resume; null when absent, expired, or another agent's. */
  load(slug: string, sessionId: string): Promise<SessionResumeState | null>;
};

const StoredStateSchema = z.object({
  state: z.record(z.string(), z.unknown()).optional(),
  notes: z.record(z.string(), z.string()).optional(),
});

const TABLE = "aai_platform.session_state";
const ENSURE_TABLE_SQL = `create table if not exists ${TABLE} (
  session_id text primary key,
  slug text not null,
  data jsonb not null,
  expires_at timestamptz not null
)`;

// The sweep filters on expiry; without this index it is a sequential scan
// of the whole table on every disconnect, on every replica.
const ENSURE_INDEX_SQL = `create index if not exists session_state_expires_at
on ${TABLE} (expires_at)`;

const SAVE_SQL = `insert into ${TABLE} (session_id, slug, data, expires_at)
values ($1, $2, $3::jsonb, now() + $4::int * interval '1 millisecond')
on conflict (session_id) do update
  set slug = excluded.slug, data = excluded.data, expires_at = excluded.expires_at`;

const LOAD_SQL = `select data from ${TABLE}
where session_id = $1 and slug = $2 and expires_at > now()`;

// Expired rows are dead weight nothing reads (LOAD filters on expires_at);
// swept opportunistically on save so the table tracks recently disconnected
// sessions, not all sessions ever.
const SWEEP_SQL = `delete from ${TABLE} where expires_at <= now()`;

/**
 * Postgres-backed store over the platform admin connection. Schema/table are
 * created lazily and memoized (same pattern as the studio stores); the row
 * TTL matches the in-process resume grace window, so cross-replica and
 * same-replica resumes expire together.
 */
export function createPgSessionStateStore(sql: SqlExec): SessionStateStore {
  const ensure = ensureTableOnce(sql, ENSURE_TABLE_SQL, ENSURE_INDEX_SQL);

  return {
    async save(slug, sessionId, data) {
      await ensure();
      await sql(SAVE_SQL, [sessionId, slug, JSON.stringify(data), SESSION_RESUME_GRACE_MS]);
      // Best-effort housekeeping; a save must not fail on it.
      void sql(SWEEP_SQL).catch(() => {
        // Expired rows are retried by the next save.
      });
    },

    async load(slug, sessionId) {
      await ensure();
      const rows = await sql(LOAD_SQL, [sessionId, slug]);
      const raw = rows[0]?.data;
      if (raw == null) return null;
      const parsed = StoredStateSchema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
      // Corrupt row → resume proceeds stateless rather than failing the session.
      return parsed.success ? parsed.data : null;
    },
  };
}

/** In-memory store for dev/tests — same semantics, expiry included. */
export function createMemorySessionStateStore(): SessionStateStore {
  const rows = new Map<string, { slug: string; data: SessionResumeState; expiresAt: number }>();
  return {
    save(slug, sessionId, data) {
      rows.set(sessionId, {
        slug,
        data: structuredClone(data),
        expiresAt: Date.now() + SESSION_RESUME_GRACE_MS,
      });
      return Promise.resolve();
    },
    load(slug, sessionId) {
      const row = rows.get(sessionId);
      if (row && row.expiresAt <= Date.now()) rows.delete(sessionId); // lazy expiry
      if (!row || row.slug !== slug || row.expiresAt <= Date.now()) {
        return Promise.resolve(null);
      }
      return Promise.resolve(structuredClone(row.data));
    },
  };
}
