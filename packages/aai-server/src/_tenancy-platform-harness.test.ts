// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform arm's DISPATCH and AUDIT over a recording `SqlExec`. Whether the
 * statements it dispatches to are really partitioned is the question only a
 * real Postgres answers (`platform/tenancy.scenario.test.ts`); what is pinned
 * here is that the arm translates refusals, reads the audit back per tenant, and
 * resets through the cascade.
 */

import { describe, expect, test } from "vitest";
import { createRecordingSql } from "./_sql-test-utils.ts";
import { SLUGS } from "./_tenancy-ops-harness.ts";
import { createPlatformArm } from "./_tenancy-platform-harness.ts";

const [A, B] = SLUGS;

describe("createPlatformArm", () => {
  test("reset deletes both tenants' agents rows, then re-seeds one per tenant", async () => {
    const sql = createRecordingSql();
    await createPlatformArm(sql).reset();
    expect(sql).toHaveBeenCalledTimes(1 + SLUGS.length);
    expect(sql.mock.calls[0]?.[0]).toContain("delete from aai_platform.agents");
    expect(sql.mock.calls[0]?.[1]).toEqual([[...SLUGS]]);
    expect(sql.mock.calls.slice(1).map(([, params]) => params)).toEqual(
      SLUGS.map((slug) => [slug]),
    );
  });

  test("a taken run id is answered as a refusal VALUE, not thrown", async () => {
    // `createRun`'s insert reports no row: the store's duplicate refusal.
    const sql = createRecordingSql(() => []);
    await expect(
      createPlatformArm(sql).apply({
        t: "createRun",
        slug: A,
        runId: "r",
        workflow: "wf",
        input: undefined,
        createdAt: 1,
      }),
    ).resolves.toEqual({ refused: "run-taken" });
  });

  test("a held hook token is a refusal naming the holder, parsed from the store's error", async () => {
    const sql = createRecordingSql(() => [
      {
        run_id: "wrun_other",
        key: "h",
        token: "tok",
        delivered: false,
        payload: null,
        closed: false,
      },
    ]);
    await expect(
      createPlatformArm(sql).apply({ t: "claimHook", slug: A, runId: "r", key: "h", token: "tok" }),
    ).resolves.toEqual({ refused: "hook-token", holder: "wrun_other" });
  });

  test("dumpAll partitions the audit rows by slug, converting and sorting them", async () => {
    const sql = createRecordingSql((query) => {
      if (!query.includes("aai_platform.workflow_runs")) return [];
      const row = (slug: string, runId: string) => ({
        slug,
        run_id: runId,
        workflow: "wf",
        status: "pending",
        created_at: "1700000000000",
        input: null,
        output: null,
        error: null,
      });
      return [row(B, "z"), row(A, "b"), row(A, "a"), row("someone-else", "x")];
    });
    const dumps = await createPlatformArm(sql).dumpAll();
    expect(dumps[A].runs.map((r) => r.runId)).toEqual(["a", "b"]);
    expect(dumps[B].runs.map((r) => r.runId)).toEqual(["z"]);
    expect(dumps[A].runs[0]?.createdAt).toBe(1_700_000_000_000);
    expect(dumps[A].runs[0]?.input).toBeUndefined();
    // Eight tables, each one select scoped to the two tenants.
    expect(sql).toHaveBeenCalledTimes(8);
    for (const [, params] of sql.mock.calls) expect(params).toEqual([[...SLUGS]]);
  });
});
