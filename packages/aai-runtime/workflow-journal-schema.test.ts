// Copyright 2026 the AAI authors. MIT license.
/**
 * The journal's schema half: that the DDL declares what the store queries, and
 * that applying it can never stop a boot.
 */

import { describe, expect, test, vi } from "vitest";
import { recordingDb } from "./_test-utils.ts";
import { applyWorkflowJournalDdl, workflowJournalDdl } from "./workflow-journal-schema.ts";

/** A `Logger` that records rather than prints. */
function quietLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("the DDL", () => {
  test("declares all five tables, and qualifies them when given a schema", () => {
    const bare = workflowJournalDdl().join("\n");
    // `attempt_leases` and not `attempts`: a charge is a row per outstanding
    // attempt now, which needed the holder in the primary key and so a new
    // table. `journal-ddl-parity.test.ts` is what keeps the platform's copy
    // renamed with it.
    for (const table of ["runs", "steps", "attempt_leases", "sleeps", "hooks"]) {
      expect(bare).toContain(`aai_workflow_${table}`);
    }
    expect(workflowJournalDdl("aai_platform").join("\n")).toContain('"aai_platform".aai_workflow');
  });

  test("applying it is NEVER fatal — a role that may not CREATE keeps booting", async () => {
    // A real migration may already own these tables, in which case the backend's
    // own error is the better diagnostic than a refused boot.
    const logger = quietLogger();
    const db = {
      query: vi.fn(async () => {
        throw new Error("permission denied for schema public");
      }),
    };
    await expect(applyWorkflowJournalDdl({ db, logger })).resolves.toBe(false);
    const warn = logger.warn;
    expect(warn).toHaveBeenCalledWith(
      "Workflow journal schema not applied",
      expect.objectContaining({ error: expect.stringContaining("permission denied") }),
    );
  });

  test("reports true when every statement lands", async () => {
    const db = recordingDb();
    expect(await applyWorkflowJournalDdl({ db, logger: quietLogger() })).toBe(true);
  });
});
