// Copyright 2026 the AAI authors. MIT license.
/**
 * The blob GC's command TEXT. Moved from `pg-cron.test.ts`, which keeps the one
 * case about scheduling (the job is declared only with object storage). What the
 * command actually deletes is asserted against a real Postgres in
 * `pg-cron.scenario.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { sweepBlobGc } from "./pg-cron-blob-gc.ts";

describe("blob GC", () => {
  const command = () => sweepBlobGc({ url: "https://proj.supabase.co", bucket: "aai-blobs" });

  test("refuses to run against an empty agents table", () => {
    // The catastrophic failure: read zero referenced hashes, conclude every
    // blob is garbage. One bad read away, and unrecoverable.
    expect(command()).toContain("select count(*) into live_agents from aai_platform.agents");
    expect(command()).toContain("if live_agents = 0 then");
  });

  test("treats both worker and client blobs as referenced", () => {
    // client_files is path→hash, so the live set needs its VALUES; taking its
    // keys would mark every client asset unreferenced.
    expect(command()).toContain("select worker_hash as hash from aai_platform.agents");
    expect(command()).toContain("jsonb_each_text(a.client_files) f");
    expect(command()).toContain("select f.value");
  });

  test("only considers aged blobs, and bounds each run", () => {
    // Comfortably past the retirement drain (10 min) and the signed worker
    // URL's TTL (5 min), so a spawn can never be reaching for what it deletes.
    expect(command()).toContain("interval '1 day'");
    expect(command()).toContain("like 'blobs/%'");
    expect(command()).toContain("limit 500");
  });

  test("deletes through the Storage API, never storage.objects", () => {
    // Deleting the row orphans the S3 object AND destroys the only record it
    // exists — strictly worse than leaving it.
    expect(command()).toContain("net.http_delete");
    expect(command()).toContain("https://proj.supabase.co/storage/v1/object/aai-blobs/");
    expect(command()).not.toContain("delete from storage.objects");
    // The credential comes from Vault, never the job command.
    expect(command()).toContain("platform:storage-key");
    expect(command()).not.toContain("sb_secret_");
  });

  test("no-ops rather than erroring where its dependencies are absent", () => {
    for (const guard of [
      "to_regnamespace('net')",
      "to_regclass('storage.objects')",
      "to_regclass('vault.secrets')",
    ]) {
      expect.soft(command(), `${guard} is unguarded`).toContain(guard);
    }
  });

  /**
   * The uploads arm — the half that reclaims an uploaded BYTE, which nothing in
   * this platform did until it existed.
   *
   * These are text assertions, and text is all they can be: `pg-cron.test.ts`
   * reads the command as a string. What the arm actually SELECTS is asserted
   * against a real Postgres in `pg-cron.scenario.test.ts`, including the negative
   * that matters (an in-flight upload with no record yet is not deleted) and an
   * A/B on each guard below. These exist so a guard that is DELETED fails a test
   * somebody runs in under a second, without a database.
   */
  describe("the uploads arm", () => {
    test("refuses to run against an empty workflow_uploads table", () => {
      // The blobs arm's empty-agents guard, one table over and for the identical
      // reason: an upload RECORD is the referrer here, so a table that failed to
      // load would condemn every recording in a bucket shared by every tenant.
      expect(command()).toContain(
        "select count(*) into live_uploads from aai_platform.workflow_uploads",
      );
      expect(command()).toContain("if live_uploads = 0 then");
    });

    test("treats the presence of a record as the reference", () => {
      // Joined on the two halves of the key, which are also the record's primary
      // key — that correspondence is the whole predicate.
      expect(command()).toContain("from aai_platform.workflow_uploads u");
      expect(command()).toContain("u.slug = split_part(o.name, '/', 2)");
      expect(command()).toContain("u.id = split_part(o.name, '/', 3)");
    });

    test("only reads a key it can decompose", () => {
      // A key that does not parse is a key whose slug and id cannot be read back
      // out, so the join above would be against the wrong halves of somebody's
      // object. The arm leaves it rather than guessing.
      expect(command()).toContain("^uploads/[^/]+/[^/]+/[0-9]+$");
      expect(command()).toContain("like 'uploads/%'");
    });

    test("waits out a window longer than any sandbox can live", () => {
      // Bytes precede the record in `create` alone, and that gap is one guest
      // request inside a sandbox `SANDBOX_TIMEOUT_SECS` clamps to 86,400 seconds.
      // Three days is three times that ceiling; shortening it past a day is what
      // would start deleting uploads in flight.
      expect(command()).toContain("interval '3 days'");
      expect(command()).toContain("limit 500");
    });

    test("deletes through the Storage API, exactly as the blobs arm does", () => {
      // Both arms share one `net.http_delete` builder, so this is really asserting
      // that the shared one is what the uploads arm got: two objects deleted per
      // pass at two different prefixes, one credential path.
      const deletes = command().match(/net\.http_delete/g) ?? [];
      expect(deletes).toHaveLength(2);
      expect(command()).not.toContain("delete from storage.objects");
    });
  });

  test("a trailing slash on the project URL does not double up in the delete URL", () => {
    expect(sweepBlobGc({ url: "https://proj.supabase.co//", bucket: "b" })).toContain(
      "'https://proj.supabase.co/storage/v1/object/b/' || target.name",
    );
  });
});
