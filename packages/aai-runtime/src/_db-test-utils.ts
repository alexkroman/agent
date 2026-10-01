// Copyright 2025 the AAI authors. MIT license.

import type { Db } from "@alexkroman1/aai/internal";

/** One statement a fake `Db` was asked to run. */
export type IssuedStatement = { sql: string; params: unknown[] };

/** A fake `Db` that records every statement and answers reads from a queue. */
export type RecordingDb = Db & {
  /** Every statement issued, in order, with the parameters it was bound to. */
  readonly issued: IssuedStatement[];
  /** The same statements as bare SQL, for a caller that asserts on shape only. */
  readonly sql: string[];
};

/**
 * A `Db` that records what it was asked and answers from a queue of rows,
 * consumed IN ORDER (so a write-then-read method gets the next entry). Holds
 * the one unavoidable cast: `Db.query<T>` lets the caller name the row type.
 */
export function recordingDb(rows: readonly Record<string, unknown>[][] = []): RecordingDb {
  const issued: IssuedStatement[] = [];
  const queue = [...rows];
  return {
    issued,
    get sql() {
      return issued.map((statement) => statement.sql);
    },
    // A plain function rather than `vi.fn`: the mock wrapper erases the generic
    // (`Mock` fixes `T` at declaration), and `issued` is already the recording
    // a spy would have provided.
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      issued.push({ sql, params });
      return (queue.shift() ?? []) as T[];
    },
  };
}
