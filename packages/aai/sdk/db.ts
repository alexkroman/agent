// Copyright 2026 the AAI authors. MIT license.

/**
 * SQL database handle available to tool `execute` code when storage is
 * enabled for the app. Backed by the app's Supabase Postgres schema.
 *
 * @example
 * ```ts
 * import type { ToolContext } from "@alexkroman1/aai";
 * declare const ctx: ToolContext; // the context a tool's execute receives
 *
 * await ctx.db.query("insert into notes (body) values ($1)", ["hello"]);
 * const rows = await ctx.db.query<{ body: string }>("select body from notes");
 * ```
 *
 * @public
 */
export type Db = {
  /** Run one parameterized SQL statement ($1, $2… placeholders). Resolves with the result rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};
/**
 * Max rows one `ctx.db` query may return; queries that could exceed it
 * should paginate with LIMIT/OFFSET. Exceeding the cap throws rather than
 * silently truncating — a shortened result is indistinguishable from a
 * complete one. Enforced identically under `aai dev` and on the platform —
 * both route through the same Postgres driver.
 */
export const MAX_DB_RESULT_ROWS = 1000;

/**
 * Error thrown when tool code touches `ctx.db` with no database configured.
 *
 * It used to say "Storage is not enabled" and to recommend `aai storage enable`
 * or the studio's Settings → Database. Both are gone with per-app databases: the
 * platform provisions no database, so there is nothing to ENABLE — a database is
 * a `DATABASE_URL` the author points at their own provider, like any other
 * secret. A message naming a command that does not exist is worse than a vague
 * one, because it reads as authoritative.
 *
 * The guest harness keeps an import-free duplicate of this string, pinned by an
 * equality test — dev and prod must read identically.
 */
export const STORAGE_DISABLED_MESSAGE = `No database is configured for this app. \
\`ctx.db\` is a database YOU bring — the platform provisions none — so set a \
DATABASE_URL secret pointing at your own Postgres, or DATABASE_URL in the project \
.env under \`aai dev\`.`;
