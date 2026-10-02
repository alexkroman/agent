// Copyright 2026 the AAI authors. MIT license.
/**
 * The things every upload-store spec needs, and no single test file may own.
 *
 * One copy, because a fake that falls behind the store's statements answers `[]`
 * silently — a green suite over a store that reads nothing back.
 */

import { createHash } from "node:crypto";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { recordingDb as recordingBaseDb } from "./_db-test-utils.ts";
import type { UploadBackend, UploadPart } from "./uploads/index.ts";
import { createMemoryUploadBackend, createUploadStore, UPLOADS_TABLE } from "./workflow/uploads.ts";

/** One body, as the routes hand it over: an async iterable of chunks. */
export async function* body(...pieces: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield piece;
}

/**
 * `n` bytes counting up, so a window's CONTENT identifies its offset.
 *
 * **Tiled from one period, not built per element**: a callback per byte is too slow
 * for the multi-megabyte bodies the part-boundary specs ask for under the unit
 * tier's budget. Equal to `(from + at) % 251` at every byte, since that has
 * period 251.
 */
export function ramp(n: number, from = 0): Uint8Array {
  const out = new Uint8Array(n);
  const period = new Uint8Array(Math.min(n, RAMP_PERIOD));
  for (let at = 0; at < period.length; at++) period[at] = (from + at) % RAMP_PERIOD;
  for (let at = 0; at < n; at += RAMP_PERIOD) {
    out.set(period.subarray(0, Math.min(RAMP_PERIOD, n - at)), at);
  }
  return out;
}

/** The ramp's modulus, and therefore its tile width. */
const RAMP_PERIOD = 251;

/** A body's bytes, for an assertion that names megabytes without comparing them. */
export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What one upload's row holds in the fake, in the driver's own shapes. */
type FakeRow = {
  name: string;
  type: string;
  size: number;
  complete: boolean;
  expected?: number;
  parts: UploadPart[];
};

/**
 * A `Db` that records statements and answers the reads the store makes.
 *
 * A handler TABLE rather than an if/else chain, for the reason the workflow API's
 * router uses one: a chain over these statement shapes is well past the lint ceiling
 * for cognitive complexity, and a table makes it visible that every handler is
 * matched by a SUBSTRING of the real SQL — which is what has to keep up when the
 * store's statements change.
 *
 * Only rows: bytes are objects (`createMemoryUploadBackend`) and coverage is one
 * `jsonb` column the store merges in JavaScript. Built over `_db-test-utils`'
 * `recordingDb`, answering by statement through its `answer` hook.
 */
export function recordingDb(options: { refuse?: string } = {}) {
  const sql: string[] = [];
  /**
   * Every statement's PARAMETERS, so a spec can assert what the database was asked
   * to hold rather than only what it was asked to do — in particular that no
   * parameter is ever a `Uint8Array` (bytes never go to the record's home).
   */
  const params: unknown[][] = [];
  const uploads = new Map<string, FakeRow>();

  /** The declared total a PARTS claim carries, which a streaming claim does not. */
  const declaredTotal = (param: unknown): number | undefined =>
    param === null || param === undefined ? undefined : Number(param);

  /** A row as the DRIVER answers it: `bigint` as a string, absent `expected` as null. */
  const asRead = (id: string, row: FakeRow) => ({
    id,
    name: row.name,
    type: row.type,
    // `bigint` comes back from the driver as a STRING, which is the shape the store
    // has to cope with.
    size: String(row.size),
    complete: row.complete,
    // NULL rather than absent, which is what the driver answers for a column that
    // was never set — and what the store reads to tell a parts upload from a
    // streamed one. Left `undefined`, every streamed upload reads as a parts upload
    // here and nowhere else.
    expected: row.expected === undefined ? null : String(row.expected),
    // The ARRAY, which is what postgres.js hands back for a `jsonb` column holding
    // one. `partsOf` makes the store not care: a fake can only hold the shape its
    // author believed in, so it must not be the authority — `jsonb_typeof` in
    // `workflow-uploads.scenario.test.ts` is.
    parts: row.parts,
  });

  const handlers: readonly { when: string; run: (params: unknown[]) => unknown[] }[] = [
    {
      // The claim, for both `stream` and `beginParts`. `do nothing` on conflict with
      // `returning id`, so a row comes back only for a statement that INSERTED —
      // which is what refuses a taken id, so a fake that always answered would let
      // two callers declare the same upload.
      when: "on conflict (id) do nothing",
      run: (params) => {
        const id = String(params[0]);
        if (uploads.has(id)) return [];
        uploads.set(id, {
          name: String(params[1]),
          type: String(params[2]),
          size: 0,
          complete: params[3] === true,
          parts: [],
          ...omitUndefined({ expected: declaredTotal(params[4]) }),
        });
        return [{ id }];
      },
    },
    {
      // The unconditional insert `create` finishes with — the row appears only once
      // every window is stored, which is the invariant `uploads/store.ts` states.
      when: `insert into ${UPLOADS_TABLE}`,
      run: (params) => {
        uploads.set(String(params[0]), {
          name: String(params[1]),
          type: String(params[2]),
          size: Number(params[3]),
          complete: true,
          parts: JSON.parse(String(params[4])) as UploadPart[],
        });
        return [];
      },
    },
    {
      // The one place `parts` is written. BEFORE the two plain size updates, whose
      // texts this one contains.
      when: "set parts = $2",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row) {
          uploads.set(String(params[0]), {
            ...row,
            parts: JSON.parse(String(params[1])) as UploadPart[],
            size: Number(params[2]),
            complete: Boolean(params[3]),
          });
        }
        return [];
      },
    },
    {
      when: "complete = true where id",
      run: (params) => {
        const row = uploads.get(String(params[0]));
        if (row)
          uploads.set(String(params[0]), { ...row, size: Number(params[1]), complete: true });
        return [];
      },
    },
    {
      when: `from ${UPLOADS_TABLE} where id =`,
      run: (params) => {
        const id = String(params[0]);
        const row = uploads.get(id);
        return row ? [asRead(id, row)] : [];
      },
    },
  ];

  const db = recordingBaseDb([], {
    answer: (text, params_) => {
      sql.push(text.replace(/\s+/g, " ").trim());
      params.push(params_);
      // One statement the store is allowed to lose — see the spec that names it.
      if (options.refuse && text.includes(options.refuse))
        throw new Error(`refused: ${options.refuse}`);
      // First match wins, so the handlers are ordered narrowest-first wherever one
      // statement's text contains another's.
      return handlers.find((handler) => text.includes(handler.when))?.run(params_) ?? [];
    },
  });
  return { db, sql, params, uploads };
}

/**
 * The store as every spec builds it: recorded rows, in-memory objects.
 *
 * One arm: `UploadBackend` is a window read and a length, so
 * `createMemoryUploadBackend` is equivalent to a bucket by construction, and the
 * record has exactly one implementation to test.
 */
export function memoryStore(options: { refuse?: string; maxBytes?: number } = {}) {
  const recorder = recordingDb(omitUndefined({ refuse: options.refuse }));
  const inner = createMemoryUploadBackend();
  /**
   * Every byte operation, in order, as `"<verb> <key>"`.
   *
   * Interleaved with `sql` by nothing, deliberately: what a spec needs is the ORDER
   * of the two streams relative to each other ("the row is written after the bytes"),
   * and a shared counter is how that is expressed without either recorder knowing
   * about the other.
   */
  const ops: string[] = [];
  const blobs: UploadBackend = {
    put: async (key, body, options) => {
      ops.push(`put ${key}`);
      return await inner.put(key, body, options);
    },
    read: async (key, start, end) => {
      ops.push(`read ${key}`);
      return await inner.read(key, start, end);
    },
    size: async (key) => {
      ops.push(`size ${key}`);
      return await inner.size(key);
    },
  };
  const store = createUploadStore({
    home: { kind: "postgres", db: recorder.db },
    blobs,
    ...omitUndefined({ maxBytes: options.maxBytes }),
  });
  /** Keys the bucket really holds, so a spec can ask about the byte LAYOUT. */
  const stored = async (id: string): Promise<{ at: number; bytes: number }[]> => {
    const keys = [...new Set(ops.map((op) => op.split(" ")[1] ?? ""))].filter((key) =>
      key.includes(`/${id}/`),
    );
    const found = await Promise.all(
      keys.map(async (key) => ({
        at: Number(key.split("/").at(-1)),
        bytes: (await inner.size(key)) ?? -1,
      })),
    );
    return found.filter((one) => one.bytes >= 0).toSorted((a, b) => a.at - b.at);
  };
  return { ...recorder, blobs, ops, stored, store };
}
