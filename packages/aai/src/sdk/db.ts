// Copyright 2026 the AAI authors. MIT license.

/**
 * A minimal SQL handle: one parameterized statement in, rows out.
 *
 * **No longer an authoring type.** It was `ctx.db`, the database a tool's
 * `execute` could reach — first the platform's per-app Postgres, then whatever
 * `DATABASE_URL` an author set. The platform provisions no database and no longer
 * hands one to tool code either: an author who wants SQL brings their own client
 * (`pg`, `postgres`, a provider SDK) and their own credential, which is one fewer
 * capability on `ToolContext` and one fewer thing for the platform to be trusted
 * with.
 *
 * What it still is: the shape the RUNTIME's own Postgres consumers take — upload
 * records, the session-state backend, the workflow world's postgres arm. Those are
 * infrastructure a host configures, not something an agent's code reaches, which is
 * why this is `@internal` and off the root barrel.
 *
 * @internal
 */
export type Db = {
  /** Run one parameterized SQL statement ($1, $2… placeholders). Resolves with the result rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
};
/**
 * Max rows one {@link Db} query may return; queries that could exceed it
 * should paginate with LIMIT/OFFSET. Exceeding the cap throws rather than
 * silently truncating — a shortened result is indistinguishable from a
 * complete one. Enforced identically under `aai dev` and on the platform —
 * both route through the same Postgres driver.
 */
export const MAX_DB_RESULT_ROWS = 1000;
