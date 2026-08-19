// Copyright 2026 the AAI authors. MIT license.
/**
 * The two things every upload-store spec needs, and neither test file may own.
 *
 * `workflow-uploads.test.ts` hit the 700-line test cap when the parts specs grew, so
 * the PARTS block moved to `workflow-uploads-parts.test.ts` — and a helper copied
 * into both files is the drift this repo keeps paying for. `recordingDb` in
 * particular has already had to keep up with the store's statements twice, and the
 * failure mode both times was a fake silently answering `[]`, i.e. a green suite
 * over a store that reads nothing back. It exists ONCE.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { Db } from "../sdk/db.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import { createUploadStore, UPLOAD_CHUNKS_TABLE, UPLOADS_TABLE } from "./workflow-uploads.ts";

/** One body, as the routes hand it over: an async iterable of chunks. */
export async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}

/** The declared total a PARTS claim carries, which a streaming claim does not. */
function declaredTotal(param: unknown): number | undefined {
  return param === undefined ? undefined : Number(param);
}

/** `n` bytes counting up, so a window's CONTENT identifies its offset. */
export function ramp(n: number, from = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, at) => (from + at) % 251);
}

/** A body's bytes, for an assertion that names megabytes without comparing them. */
export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A file-backed store over a temp directory this module cleans up. */
export async function fileStore() {
  const dir = await mkdtemp(join(tmpdir(), "aai-uploads-"));
  dirs.push(dir);
  return createUploadStore({ dir });
}

/** The merged windows one upload's chunks cover, sorted, touching ones joined. */
function islandsOf(
  chunks: readonly { id: string; offset: number; bytes: Uint8Array }[],
  id: string,
): { start_at: string; end_at: string }[] {
  const covered = chunks.filter((chunk) => chunk.id === id).sort((a, b) => a.offset - b.offset);
  const islands: { start_at: string; end_at: string }[] = [];
  for (const chunk of covered) {
    const last = islands.at(-1);
    if (last && Number(last.end_at) === chunk.offset) {
      last.end_at = String(chunk.offset + chunk.bytes.length);
    } else {
      islands.push({
        start_at: String(chunk.offset),
        end_at: String(chunk.offset + chunk.bytes.length),
      });
    }
  }
  return islands;
}

/**
 * A `Db` that records statements and answers the reads this store makes.
 *
 * A handler TABLE rather than an if/else chain, for the reason the workflow API's
 * router uses one: the statement shapes are well past the lint ceiling for
 * cognitive complexity as a chain, and a table makes it visible that every handler
 * is matched by a SUBSTRING of the real SQL — which is what has to keep up when the
 * store's statements change. It has already had to twice, and both times the
 * alternative was a fake silently answering `[]`, i.e. a green suite over a store
 * that reads nothing back.
 */
export function recordingDb(opts: { refuse?: string } = {}) {
  const sql: string[] = [];
  const uploads = new Map<
    string,
    { name: string; type: string; size: number; complete: boolean; expected?: number }
  >();
  const chunks: { id: string; seq: number; offset: number; bytes: Uint8Array }[] = [];

  const handlers: readonly {
    when: string;
    // The statement TEXT as well as its parameters: one handler reads its own
    // `limit` off it — see the islands walk below.
    run: (params: unknown[], text: string) => unknown[];
  }[] = [
    {
      when: `insert into ${UPLOAD_CHUNKS_TABLE}`,
      // VARIADIC, because the parts writer commits several chunks per statement and
      // `create`/`stream` commit one — `[id, seq, offset, bytes, seq, offset, bytes,
      // …]` either way. Read as a fixed `params[1..3]` this dropped every chunk of a
      // batch but the first, which is a 4x silent data loss the suite could not see:
      // every parts test wrote a part of exactly one chunk, so every batch was of
      // size one. Hence `a part of SEVERAL chunks` below.
      run: (params) => {
        const id = String(params[0]);
        for (let at = 1; at + 2 < params.length + 1; at += 3) {
          const row = {
            id,
            seq: Number(params[at]),
            offset: Number(params[at + 1]),
            bytes: params[at + 2] as Uint8Array,
          };
          // Keyed by `(upload_id, seq)`, as the table is — the parts writer UPSERTS,
          // so a fake that appended would let a retried part read back doubled.
          const found = chunks.findIndex((one) => one.id === row.id && one.seq === row.seq);
          if (found >= 0) chunks[found] = row;
          else chunks.push(row);
        }
        return [];
      },
    },
    {
      // The contiguous prefix, which the real statement computes with a window
      // function. Computed here by the walk the SQL exists to avoid, so the fake
      // and the statement are independent answers to the same question.
      // BEFORE the prefix query below, whose text this also contains: both walks
      // open `with covered as` and only the group-by tells them apart.
      when: "group by island",
      run: (params, text) => {
        // One row per ISLAND, which is what the real statement's two window
        // functions produce — computed here by the walk the SQL exists to avoid, so
        // the fake and the statement are independent answers to the same question.
        const islands = islandsOf(chunks, String(params[0]));
        // Its `limit` is read OFF THE STATEMENT rather than from a shared constant:
        // the store detects "too many to report" by asking for one more row than it
        // will accept, so a fake that truncated to its own number could never let a
        // spec reach that branch — and could never drift from the real one either.
        const limit = Number(/\blimit\s+(\d+)/.exec(text)?.[1] ?? islands.length);
        return islands.slice(0, limit);
      },
    },
    {
      when: "with covered as",
      run: (params) => {
        // The CONTIGUOUS prefix, in one row — the shape the per-part write path
        // needs, because `MAX_DB_RESULT_ROWS` makes a row-per-island query on that
        // path a throw whose likelihood the caller decides.
        const first = islandsOf(chunks, String(params[0]))[0];
        const size = first && Number(first.start_at) === 0 ? Number(first.end_at) : 0;
        return [{ size: String(size) }];
      },
    },
    {
      // Before the plain size update and the streamed one, whose texts overlap it.
      when: "set size = $2, complete = $3",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row)
          uploads.set(String(params[0]), {
            ...row,
            size: Number(params[1]),
            complete: Boolean(params[2]),
          });
        return [];
      },
    },
    {
      // The two parts reads, which name their columns in their own orders so each
      // is matchable on its own.
      when: "select expected, complete, size",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        return row
          ? [
              {
                expected: row.expected === undefined ? null : String(row.expected),
                complete: row.complete,
                size: String(row.size),
              },
            ]
          : [];
      },
    },
    {
      when: "select name, type, expected, complete",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        return row
          ? [
              {
                name: row.name,
                type: row.type,
                expected: row.expected === undefined ? null : String(row.expected),
                complete: row.complete,
              },
            ]
          : [];
      },
    },
    {
      // The streaming CLAIM. `do nothing` on conflict, so an id that is already
      // taken keeps the row it has — which is what the store reads back to decide.
      when: "on conflict (id) do nothing",
      run: (params) => {
        const id = String(params[0]);
        // `returning id` answers with a row only for a statement that INSERTED —
        // which is what the parts claim reads to refuse a taken id, so a fake that
        // always answered would let two callers declare the same upload.
        if (uploads.has(id)) return [];
        uploads.set(id, {
          name: String(params[1]),
          type: String(params[2]),
          size: 0,
          // The streaming claim passes neither; the parts claim passes both, and
          // a zero-byte upload is complete from the moment it is declared.
          complete: params[4] === true,
          ...omitUndefined({ expected: declaredTotal(params[3]) }),
        });
        return [{ id }];
      },
    },
    {
      when: `insert into ${UPLOADS_TABLE}`,
      run: (params) => {
        uploads.set(String(params[0]), {
          name: String(params[1]),
          type: String(params[2]),
          size: Number(params[3]),
          complete: true,
        });
        return [];
      },
    },
    {
      // Before the plain size update, which its text also contains.
      when: "complete = true where id",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row)
          uploads.set(String(params[0]), { ...row, size: Number(params[1]), complete: true });
        return [];
      },
    },
    {
      when: `update ${UPLOADS_TABLE} set size`,
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row) uploads.set(String(params[0]), { ...row, size: Number(params[1]) });
        return [];
      },
    },
    {
      when: "select size, complete",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        // `bigint` comes back from the driver as a STRING, which is the shape the
        // store has to cope with.
        return row ? [{ size: String(row.size), complete: row.complete }] : [];
      },
    },
    {
      when: `from ${UPLOADS_TABLE} where id =`,
      run: (params) => {
        const row = uploads.get(String(params[0]));
        // `expected` as NULL rather than absent, which is what the driver answers
        // for a column that was never set — and what the store reads to tell a
        // parts upload from a streamed one. Left `undefined`, every streamed upload
        // reads as a parts upload here and nowhere else.
        return row
          ? [{ id: params[0], ...row, size: String(row.size), expected: row.expected ?? null }]
          : [];
      },
    },
    {
      when: "substring",
      run: (params) => {
        const [id, start, end] = [String(params[0]), Number(params[1]), Number(params[2])];
        return (
          chunks
            // `order by seq` in the real statement, and it is load-bearing rather
            // than cosmetic: parts land in whatever order the network settles, so a
            // fake answering in INSERTION order reassembles a file whose windows
            // are correct and whose bytes are shuffled.
            .toSorted((a, b) => a.seq - b.seq)
            .filter(
              (chunk) =>
                chunk.id === id && chunk.offset < end && chunk.offset + chunk.bytes.length > start,
            )
            .map((chunk) => ({
              part: chunk.bytes.subarray(
                Math.max(start - chunk.offset, 0),
                Math.min(end - chunk.offset, chunk.bytes.length),
              ),
            }))
        );
      },
    },
  ];

  const db: Db = {
    query: async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => {
      sql.push(text.replace(/\s+/g, " ").trim());
      // One statement the store is allowed to lose — see the spec that names it.
      if (opts.refuse && text.includes(opts.refuse)) throw new Error(`refused: ${opts.refuse}`);
      // First match wins, so the handlers are ordered narrowest-first wherever one
      // statement's text contains another's.
      return (handlers.find((handler) => text.includes(handler.when))?.run(params, text) ??
        []) as T[];
    },
  };
  return { db, sql, chunks, uploads };
}
