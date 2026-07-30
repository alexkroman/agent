// Copyright 2026 the AAI authors. MIT license.

/**
 * SQL database handle available to tool `execute` code when storage is
 * enabled for the app. Backed by the app's Supabase Postgres schema.
 *
 * @example
 * ```ts
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
