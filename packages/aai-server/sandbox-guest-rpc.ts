// Copyright 2025 the AAI authors. MIT license.
/**
 * Guest → host RPC surface for sandboxed agents.
 *
 * The guest runs the complete agent runtime and reaches the network
 * directly (open egress — the Modal container is the boundary). One
 * capability stays host-proxied over the sandbox's
 * control channel: `ctx.db` — the per-app Postgres credentials are
 * platform-provisioned and must never enter tenant containers. This module
 * owns that surface: the Zod schema that validates untrusted guest params,
 * and the handler registration wired onto a connection before it starts
 * listening (see `configureSandbox` in sandbox-vm.ts).
 */

import type { Db } from "@alexkroman1/aai";
import { DbQueryParamsSchema, type GuestConnection } from "./rpc-schemas.ts";

// ── Handler registration ─────────────────────────────────────────────────────

export type GuestRpcOptions = {
  /** App database handle (enables the db/query RPC handler when set). */
  db?: Db | undefined;
};

/**
 * Register the host-side db RPC handler for one guest connection.
 * Must run BEFORE `conn.listen()` so no incoming guest messages are dropped.
 */
export function registerGuestRpcHandlers(conn: GuestConnection, opts: GuestRpcOptions): void {
  // Host serves guest ctx.db queries against the app's provisioned database
  // (params validated with Zod). JSON-serializability of row values is the
  // caller's problem — non-serializable values fail the frame write. The
  // row cap (MAX_DB_RESULT_ROWS) is enforced inside `createPostgresDb`,
  // which this db handle comes from (openAppDb) — not re-checked here.
  if (opts.db) {
    const db = opts.db;
    conn.onRequest("db/query", async (raw: unknown) => {
      const p = DbQueryParamsSchema.parse(raw);
      return await db.query(p.sql, p.params);
    });
  }
}
