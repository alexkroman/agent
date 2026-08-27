// Copyright 2026 the AAI authors. MIT license.
/**
 * The tenant boundary for platform-owned run storage, against a real database.
 *
 * Real Postgres rather than a fake, because every property here is a property of
 * the SCHEMA: the primary key is what makes a claim idempotent, the foreign key is
 * what forgets an agent's runs with the agent, and `on conflict (run_id) do
 * nothing` is what turns a replayed `run_created` into a no-op instead of an
 * error. A fake would assert the code I wrote around those, not the constraints
 * that do the work.
 */

import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { describeWithPg, pgUrl } from "./_pg-test-utils.ts";
import type { SqlExec } from "./secret-store.ts";
import { ensurePlatformTables } from "./test-utils.ts";
import { claimRun, forgetRunsOf, ownerOf, ownsRun, runIdsFor } from "./workflow-run-owner.ts";

describeWithPg("workflow run ownership", () => {
  let close: () => Promise<void>;
  let sql: SqlExec;

  /** Every tenant this suite creates, so `afterAll` removes exactly those. */
  const SLUGS = ["wro-a", "wro-b", "wro-gone"];

  const seedAgent = (slug: string) =>
    sql(
      `insert into aai_platform.agents
         (slug, credential_hashes, worker_hash, client_files, version)
       values ($1, '{}'::jsonb, '', '{}'::jsonb, 1) on conflict do nothing`,
      [slug],
    );

  beforeAll(async () => {
    const db = createPostgresDb({ url: pgUrl(), max: 4 });
    sql = (q, p) => db.query(q, p);
    close = () => db.close();
    await ensurePlatformTables(sql);
    for (const slug of SLUGS) await seedAgent(slug);
  });

  // Only this suite's rows, never the table — a scenario test owns its ROWS.
  beforeEach(async () => {
    await sql("delete from aai_platform.workflow_run_owner where slug = any($1)", [SLUGS]);
    for (const slug of SLUGS) await seedAgent(slug);
  });

  afterAll(async () => {
    await sql("delete from aai_platform.workflow_run_owner where slug = any($1)", [SLUGS]);
    await sql("delete from aai_platform.agents where slug = any($1)", [SLUGS]);
    await close();
  });

  test("a claimed run reads back as its owner's", async () => {
    await claimRun(sql, "run_1", SLUGS[0] as string);
    expect(await ownerOf(sql, "run_1")).toBe(SLUGS[0]);
    expect(await ownsRun(sql, "run_1", SLUGS[0] as string)).toBe(true);
  });

  test("an unclaimed run has no owner and belongs to nobody", async () => {
    expect(await ownerOf(sql, "never")).toBeUndefined();
    expect(await ownsRun(sql, "never", SLUGS[0] as string)).toBe(false);
  });

  /**
   * The property that makes the boundary a boundary.
   *
   * `ownsRun` is what every scoped read passes through, so this is the assertion
   * that one tenant cannot reach another's run — and it answers FALSE rather than
   * throwing, because "this run is not yours" and "this run does not exist" must
   * be the same answer or the reply says whether a run id exists.
   */
  test("another agent does not own it, and cannot be told the difference", async () => {
    await claimRun(sql, "run_1", SLUGS[0] as string);
    expect(await ownsRun(sql, "run_1", SLUGS[1] as string)).toBe(false);
    expect(await ownsRun(sql, "absent", SLUGS[1] as string)).toBe(false);
  });

  test("claiming twice is a no-op, because a run_created event may replay", async () => {
    // A durable run retried at its very first step re-enters the same path, and a
    // second claim must not fail the retry.
    await claimRun(sql, "run_1", SLUGS[0] as string);
    await expect(claimRun(sql, "run_1", SLUGS[0] as string)).resolves.toBeUndefined();
    expect(await ownerOf(sql, "run_1")).toBe(SLUGS[0]);
  });

  /**
   * A run cannot change hands.
   *
   * `on conflict do nothing` alone would make this SUCCEED silently, leaving the
   * run with its first owner while the second caller believes it has one — which
   * is the shape of a cross-tenant read that reports success.
   */
  test("refuses to reassign a run to a different agent", async () => {
    await claimRun(sql, "run_1", SLUGS[0] as string);
    await expect(claimRun(sql, "run_1", SLUGS[1] as string)).rejects.toThrow(
      /already owned by another agent/,
    );
    // And the first owner is untouched.
    expect(await ownerOf(sql, "run_1")).toBe(SLUGS[0]);
    expect(await ownsRun(sql, "run_1", SLUGS[1] as string)).toBe(false);
  });

  test("lists an agent's runs newest first, and only that agent's", async () => {
    for (const id of ["run_1", "run_2", "run_3"]) {
      await claimRun(sql, id, SLUGS[0] as string);
    }
    await claimRun(sql, "other_1", SLUGS[1] as string);
    const ids = await runIdsFor(sql, SLUGS[0] as string, 10);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain("other_1");
    // `created_at desc, run_id desc`: same-transaction claims share a timestamp,
    // so the id is the tiebreak and the order is total rather than arbitrary.
    expect(ids[0]).toBe("run_3");
  });

  test("honours the caller's limit rather than truncating silently at its own", async () => {
    for (const id of ["run_1", "run_2", "run_3"]) {
      await claimRun(sql, id, SLUGS[0] as string);
    }
    expect(await runIdsFor(sql, SLUGS[0] as string, 2)).toHaveLength(2);
  });

  test("an agent with no runs lists none rather than failing", async () => {
    expect(await runIdsFor(sql, SLUGS[0] as string, 10)).toEqual([]);
  });

  test("forgetting an agent's runs reports how many and leaves others alone", async () => {
    await claimRun(sql, "run_1", SLUGS[0] as string);
    await claimRun(sql, "run_2", SLUGS[0] as string);
    await claimRun(sql, "other_1", SLUGS[1] as string);
    expect(await forgetRunsOf(sql, SLUGS[0] as string)).toBe(2);
    expect(await ownerOf(sql, "run_1")).toBeUndefined();
    expect(await ownerOf(sql, "other_1")).toBe(SLUGS[1]);
  });

  /**
   * The FK does the forgetting when an agent is deleted.
   *
   * Without `on delete cascade`, deleting an agent would either fail on the
   * reference or leave rows pointing at a slug that no longer exists — and the
   * second is worse, because a slug is reusable, so a new agent could inherit its
   * predecessor's runs.
   */
  test("deleting the agent forgets its runs", async () => {
    await claimRun(sql, "run_gone", SLUGS[2] as string);
    await sql("delete from aai_platform.agents where slug = $1", [SLUGS[2]]);
    expect(await ownerOf(sql, "run_gone")).toBeUndefined();
  });

  test("refuses to claim a run for an agent that does not exist", async () => {
    // The FK again, in the other direction: an ownership row for no agent is a row
    // nothing will ever clean up.
    await expect(claimRun(sql, "run_x", "no-such-agent")).rejects.toThrow();
  });
});
