// Copyright 2026 the AAI authors. MIT license.
// The Postgres boot sweep's row mapping. Which runs it selects is pinned
// against a real database by the journal conformance's Postgres arm.

import { expect, test } from "vitest";
import { recordingDb } from "../../_db-test-utils.ts";
import { resumableRuns } from "./_resumable.ts";

test("binds the limit and maps each row, a NULL wake leaving wakeAt absent", async () => {
  const db = recordingDb([
    [
      { run_id: "wrun_a", wake_at: null },
      { run_id: "wrun_b", wake_at: "1700000000000" },
    ],
  ]);
  const runs = await resumableRuns(db, 25);
  expect(runs).toEqual([{ runId: "wrun_a" }, { runId: "wrun_b", wakeAt: 1_700_000_000_000 }]);
  expect(runs[0]).not.toHaveProperty("wakeAt");
  expect(db.issued[0]?.params).toEqual([25]);
  expect(db.sql[0]).toContain("where r.status in ('pending', 'running')");
});

test("answers an empty list when nothing is resumable", async () => {
  await expect(resumableRuns(recordingDb([[]]), 10)).resolves.toEqual([]);
});
