// Copyright 2026 the AAI authors. MIT license.
/**
 * Workflow upload records against a real database.
 *
 * Real Postgres, because every property worth asserting here is the SCHEMA's: the
 * composite primary key is what makes `claim` refusable and what makes tenancy
 * structural, `bigint` is what lets a 2 GiB upload be represented at all (and what
 * hands a STRING back to the driver), and `jsonb` is what rejects a boundary list
 * that is not JSON.
 *
 * Two of these are the traps the module doc names, and both fail silently:
 *
 * - `expected` ABSENT is a different value from `expected = 0`. It is what says
 *   "not a parts upload", which decides whether completion is judged by a declared
 *   total or by the body ending. A coercion that turns NULL into 0 makes every
 *   streamed upload look like a parts upload declaring nothing.
 * - `size` is a `bigint`, so the driver answers with a string. `Number(null)` is 0,
 *   so a read that coerces before checking reports a plausible empty upload.
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import { ensurePlatformTables } from "./platform-schema-test-utils.ts";
import {
  claimUpload,
  finishUpload,
  insertUpload,
  PlatformUploadIdTakenError,
  readUpload,
  updateUpload,
} from "./platform-uploads.ts";
import type { SqlExec } from "./secret-store.ts";

describeWithPg("platform upload records", () => {
  let close: () => Promise<void>;
  let sql: SqlExec;

  const SLUGS = ["upl-a", "upl-b"];
  const A = () => SLUGS[0] as string;
  const B = () => SLUGS[1] as string;

  const seedAgent = (slug: string) =>
    sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  const record = (over: Record<string, unknown> = {}) => ({
    name: "clip.wav",
    type: "audio/wav",
    size: 0,
    complete: false,
    parts: [],
    ...over,
  });

  beforeAll(async () => {
    const db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    close = () => db.close();
    await ensurePlatformTables(sql);
    for (const slug of SLUGS) await seedAgent(slug);
  });

  beforeEach(async () => {
    // Only this suite's rows, never the table.
    await sql("delete from aai_platform.workflow_uploads where slug = any($1)", [SLUGS]);
    for (const slug of SLUGS) await seedAgent(slug);
  });

  afterAll(async () => {
    await sql("delete from aai_platform.workflow_uploads where slug = any($1)", [SLUGS]);
    await sql("delete from aai_platform.agents where slug = any($1)", [SLUGS]);
    await close();
  });

  test("a claimed record reads back with every field intact", async () => {
    await claimUpload(sql, A(), "u1", record({ expected: 1024, parts: [{ at: 0, bytes: 512 }] }));
    expect(await readUpload(sql, A(), "u1")).toEqual({
      name: "clip.wav",
      type: "audio/wav",
      size: 0,
      complete: false,
      expected: 1024,
      parts: [{ at: 0, bytes: 512 }],
    });
  });

  test("an unknown id reads as undefined rather than failing", async () => {
    expect(await readUpload(sql, A(), "never-seen")).toBeUndefined();
  });

  /**
   * THE trap: absent is not zero.
   *
   * `expected` absent means "not a parts upload", so completion is decided by the
   * body ending. A read that coerced NULL to 0 would make every streamed upload
   * look like a parts upload that declared nothing — and `size >= expected` is then
   * true immediately, so it would report complete before any bytes arrived.
   */
  test("expected stays ABSENT rather than becoming 0", async () => {
    await claimUpload(sql, A(), "streamed", record());
    const held = await readUpload(sql, A(), "streamed");
    expect(held).toBeDefined();
    expect(held && "expected" in held).toBe(false);
  });

  test("expected = 0 is preserved as a real declared total", async () => {
    // The other side of the same distinction: a parts upload MAY declare zero, and
    // that must not read as absent.
    await claimUpload(sql, A(), "empty-parts", record({ expected: 0 }));
    expect(await readUpload(sql, A(), "empty-parts")).toMatchObject({ expected: 0 });
  });

  /**
   * `bigint`, which is what a 2 GiB upload needs and what the driver stringifies.
   */
  test("a size past 2^31 survives the round trip as a number", async () => {
    const big = 3_000_000_000;
    await insertUpload(sql, A(), "big", record({ size: big, complete: true }));
    const held = await readUpload(sql, A(), "big");
    expect(held?.size).toBe(big);
    expect(typeof held?.size).toBe("number");
  });

  test("claiming a held id THROWS, even for an identical declaration", async () => {
    // What makes a caller-chosen id safe: the refusal is the point, and an
    // identical body must not be treated as idempotent.
    await claimUpload(sql, A(), "dup", record());
    await expect(claimUpload(sql, A(), "dup", record())).rejects.toThrow(
      PlatformUploadIdTakenError,
    );
  });

  test("insert is an UPSERT, so a retried request is idempotent", async () => {
    // Unlike claim: this id was minted by the store and cannot collide, so "already
    // taken" must not be a reachable failure for a caller that chose no id.
    await insertUpload(sql, A(), "minted", record({ size: 10, complete: true }));
    await insertUpload(sql, A(), "minted", record({ size: 20, complete: true }));
    expect(await readUpload(sql, A(), "minted")).toMatchObject({ size: 20 });
  });

  test("update publishes the prefix and boundaries, leaving the declaration alone", async () => {
    await claimUpload(sql, A(), "u2", record({ expected: 900, name: "keep.wav" }));
    await updateUpload(sql, A(), "u2", {
      size: 512,
      complete: false,
      parts: [{ at: 0, bytes: 512 }],
    });
    expect(await readUpload(sql, A(), "u2")).toEqual({
      // `name` and `expected` are the DECLARATION's — an update that rewrote them
      // would let a late window silently redeclare the upload's total.
      name: "keep.wav",
      type: "audio/wav",
      size: 512,
      complete: false,
      expected: 900,
      parts: [{ at: 0, bytes: 512 }],
    });
  });

  test("finish completes without touching the boundary list", async () => {
    // A streamed upload's every window has already joined the list, so there is
    // nothing to merge — and `parts` must survive exactly.
    const parts = [
      { at: 0, bytes: 8 },
      { at: 8, bytes: 4 },
    ];
    await claimUpload(sql, A(), "u3", record({ parts }));
    await finishUpload(sql, A(), "u3", 12);
    expect(await readUpload(sql, A(), "u3")).toMatchObject({
      size: 12,
      complete: true,
      parts,
    });
  });

  /**
   * Tenancy is in the KEY, so this needs no check to pass.
   */
  test("two agents may hold the SAME upload id without seeing each other's", async () => {
    await claimUpload(sql, A(), "shared-id", record({ name: "a.wav" }));
    // Not a conflict: the primary key is (slug, id), which is also what stops one
    // tenant's id space from colliding with another's — or leaking through a
    // refused claim.
    await claimUpload(sql, B(), "shared-id", record({ name: "b.wav" }));
    expect(await readUpload(sql, A(), "shared-id")).toMatchObject({ name: "a.wav" });
    expect(await readUpload(sql, B(), "shared-id")).toMatchObject({ name: "b.wav" });
  });

  test("an update cannot reach another agent's row", async () => {
    await claimUpload(sql, A(), "mine", record({ size: 1 }));
    await claimUpload(sql, B(), "mine", record({ size: 2 }));
    await updateUpload(sql, B(), "mine", { size: 99, complete: true, parts: [] });
    expect(await readUpload(sql, A(), "mine")).toMatchObject({ size: 1 });
  });

  test("deleting the agent takes its upload records with it", async () => {
    await claimUpload(sql, B(), "cascade", record());
    await sql("delete from aai_platform.agents where slug = $1", [B()]);
    expect(await readUpload(sql, B(), "cascade")).toBeUndefined();
  });

  test("refuses a boundary list that is not JSON-shaped", async () => {
    // `jsonb` parses on write, which is the check this process cannot fake. Driven
    // through raw SQL because the typed API cannot express it.
    await expect(
      sql(
        `insert into aai_platform.workflow_uploads (slug, id, size, parts)
         values ($1, 'bad', 0, $2::text::jsonb)`,
        [A(), "not json at all"],
      ),
    ).rejects.toThrow();
  });
});
