// Copyright 2026 the AAI authors. MIT license.
/**
 * Cross-replica registry of live studio coding-agent sandboxes.
 *
 * The broker's `sessions` map, its `sessionLock`, and its idle sweeper are
 * all in-process, and the web service autoscales — so before this, two
 * replicas each spawned a sandbox for the same (scope, project). That is not
 * a rare race: Modal routes every request independently, so a page load and
 * the project switch a minute later routinely land on different replicas.
 * Two live guests for one project means a duplicate billed sandbox AND two
 * `studio/sync-workspace` writers racing on the same workspace row.
 *
 * WHY THIS IS NOT THE AGENT REGISTRY (aai-server/sandbox-registry.ts). An
 * agent guest is stateless to the host: a peer replica hands its URL to the
 * browser and is done. A studio guest holds INSTALLED SESSION STATE — the
 * materialized workspace, the caller's key, the system prompt — which a
 * broker call must be able to refresh so the coding agent never edits a
 * stale tree. So this row carries what a peer needs to do that:
 *
 * - `chatUrl` + `chatToken` — what the browser is handed. The token is
 *   minted ONCE PER SANDBOX and stored here so every replica returns the
 *   SAME one; re-minting per broker call would revoke the token every other
 *   tab is still holding.
 * - `guestOrigin` + `sandboxToken` — how a peer reaches the guest's
 *   `POST /studio/session-init` to reinstall the workspace. The peer cannot
 *   use the control socket: a harness accepts exactly one, and the owner has
 *   it (see aai-guest/studio-session-init.ts).
 *
 * OWNERSHIP. `owner` is the replica holding the control socket, and only it
 * may spawn, dispose, or answer the guest's RPCs. A peer only ever reads the
 * row and re-installs over HTTP. So there is no ownership transfer, no
 * second socket, and no cross-replica termination — the three things that
 * would turn this into a distributed-consensus problem.
 *
 * LIVENESS is the lease, refreshed by any replica that brokers the project
 * and by the owner's end-of-turn RPCs. But unlike the agent registry, a peer
 * does not have to TRUST the lease: its session install is itself the
 * liveness probe (studio-session-adopt.ts). A failed install means the guest
 * is gone, so the peer drops the row and takes the cold path — a stale row
 * costs one failed HTTP round trip, never a dead URL handed to a browser.
 *
 * Same two-implementation pattern as every platform store; the memory
 * registry is what dev and tests run on.
 */

import type { SqlExec } from "aai-server/secret-store";
import { projectKey } from "./studio-workspace.ts";

/**
 * How long a session stays live without activity — the registry lease AND
 * the broker's local idle window, deliberately ONE number.
 *
 * They have to agree. The owner's sweeper tears a sandbox down on local
 * idleness, but a peer replica's broker call is activity the owner cannot
 * see; all it leaves behind is a touched lease. So "the row is unexpired"
 * has to mean exactly "someone brokered within the idle window", or the
 * sweeper is reading a different clock than the one it is deciding on. It
 * lives here rather than in the broker because the broker imports this
 * module, not the other way round.
 *
 * The value matches the agent guest's own idle self-exit
 * (`AGENT_IDLE_EXIT_MS`, 5 min): a studio sandbox costs exactly what a
 * deployed agent's does. Losing a live-but-quiet one costs a single
 * re-broker — the client re-brokers on a rejected fetch, a 409, or a 401,
 * and the workspace and chat live in the store, not the guest. The broker's
 * sweeper runs on a 60s cadence, so the effective local window is this value
 * plus up to a minute.
 */
export const STUDIO_SESSION_IDLE_MS = 5 * 60_000;

export type StudioSessionRecord = {
  /** The guest's public chat endpoint — handed to the browser. */
  chatUrl: string;
  /** Per-session bearer for that endpoint. Minted once per SANDBOX. */
  chatToken: string;
  /** The guest's origin (`ws(s)://host:port`), for the session-init POST. */
  guestOrigin: string;
  /** Per-sandbox host bearer. A PLATFORM secret — never sent to a browser. */
  sandboxToken: string;
  /** The replica holding this guest's control socket. */
  owner: string;
};

export type StudioSessionRegistry = {
  /** The live (unexpired) record for this project, or null. */
  get(scope: string, project: string): Promise<StudioSessionRecord | null>;
  /** Record this replica's fresh sandbox, replacing any prior row. */
  claim(scope: string, project: string, record: StudioSessionRecord): Promise<void>;
  /** Extend the lease. Safe from any replica — brokering is activity. */
  touch(scope: string, project: string): Promise<void>;
  /**
   * Drop the row, but only while `owner` still holds it. Identity-checked
   * for the same reason `createOwnedMap` exists on the local side: every
   * release runs after an await, by which point a replacement sandbox may
   * already have claimed the key, and evicting it would strand a live guest.
   */
  release(scope: string, project: string, owner: string): Promise<void>;
};

const TABLE = "aai_platform.studio_sessions";

const GET_SQL = `select chat_url, chat_token, guest_origin, sandbox_token, owner
from ${TABLE}
where scope = $1 and project = $2 and expires_at > now()`;

const CLAIM_SQL = `insert into ${TABLE} as s
  (scope, project, chat_url, chat_token, guest_origin, sandbox_token, owner, expires_at)
values ($1, $2, $3, $4, $5, $6, $7, now() + $8::int * interval '1 millisecond')
on conflict (scope, project) do update set
  chat_url = excluded.chat_url,
  chat_token = excluded.chat_token,
  guest_origin = excluded.guest_origin,
  sandbox_token = excluded.sandbox_token,
  owner = excluded.owner,
  expires_at = excluded.expires_at`;

const TOUCH_SQL = `update ${TABLE}
set expires_at = now() + $3::int * interval '1 millisecond'
where scope = $1 and project = $2`;

const RELEASE_SQL = `delete from ${TABLE} where scope = $1 and project = $2 and owner = $3`;

export type PgStudioSessionRegistryOptions = { leaseMs?: number };

/** Postgres lease-backed registry over the platform admin connection. */
export function createPgStudioSessionRegistry(
  sql: SqlExec,
  opts: PgStudioSessionRegistryOptions = {},
): StudioSessionRegistry {
  const leaseMs = opts.leaseMs ?? STUDIO_SESSION_IDLE_MS;

  return {
    async get(scope, project) {
      const rows = await sql(GET_SQL, [scope, project]);
      const row = rows[0];
      if (!row) return null;
      return {
        chatUrl: String(row.chat_url),
        chatToken: String(row.chat_token),
        guestOrigin: String(row.guest_origin),
        sandboxToken: String(row.sandbox_token),
        owner: String(row.owner),
      };
    },
    async claim(scope, project, record) {
      await sql(CLAIM_SQL, [
        scope,
        project,
        record.chatUrl,
        record.chatToken,
        record.guestOrigin,
        record.sandboxToken,
        record.owner,
        leaseMs,
      ]);
    },
    async touch(scope, project) {
      await sql(TOUCH_SQL, [scope, project, leaseMs]);
    },
    async release(scope, project, owner) {
      await sql(RELEASE_SQL, [scope, project, owner]);
    },
  };
}

/** In-memory registry for dev and tests — one process, so never a peer. */
export function createMemoryStudioSessionRegistry(
  opts: PgStudioSessionRegistryOptions = {},
): StudioSessionRegistry {
  const leaseMs = opts.leaseMs ?? STUDIO_SESSION_IDLE_MS;
  const rows = new Map<string, { record: StudioSessionRecord; expiresAt: number }>();

  return {
    get(scope, project) {
      const key = projectKey(scope, project);
      const row = rows.get(key);
      if (!row) return Promise.resolve(null);
      if (row.expiresAt <= Date.now()) {
        rows.delete(key);
        return Promise.resolve(null);
      }
      return Promise.resolve(row.record);
    },
    claim(scope, project, record) {
      rows.set(projectKey(scope, project), { record, expiresAt: Date.now() + leaseMs });
      return Promise.resolve();
    },
    touch(scope, project) {
      const row = rows.get(projectKey(scope, project));
      if (row) row.expiresAt = Date.now() + leaseMs;
      return Promise.resolve();
    },
    release(scope, project, owner) {
      const key = projectKey(scope, project);
      if (rows.get(key)?.record.owner === owner) rows.delete(key);
      return Promise.resolve();
    },
  };
}
