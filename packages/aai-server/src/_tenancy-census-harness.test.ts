// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { emptyCensus, NEIGHBOUR, noteAnswer, noteOp } from "./_tenancy-census-harness.ts";
import { emptyDump, type Slug, type TenantDump } from "./_tenancy-ops-harness.ts";

const A: Slug = "tenancy-alpha";
const B: Slug = "tenancy-beta";

const run = (runId: string, status = "running"): TenantDump["runs"][number] => ({
  runId,
  workflow: "wf",
  status,
  createdAt: 1,
  input: undefined,
  output: undefined,
  error: undefined,
});
const hook = (runId: string, token: string): TenantDump["hooks"][number] => ({
  runId,
  key: "hook!0",
  token,
  delivered: false,
  payload: undefined,
  closed: false,
});

describe("the collision census", () => {
  test("NEIGHBOUR pairs the two tenants both ways", () => {
    expect(NEIGHBOUR[A]).toBe(B);
    expect(NEIGHBOUR[B]).toBe(A);
  });

  test("a read for a run only the neighbour holds is a foreign read, not a shared run", () => {
    const seen = emptyCensus();
    noteOp(
      seen,
      { [A]: emptyDump(), [B]: { ...emptyDump(), runs: [run("r1")] } },
      {
        t: "getRun",
        slug: A,
        runId: "r1",
      },
    );
    expect(seen).toEqual({ ...emptyCensus(), foreignRunReads: 1 });
  });

  test("a run id both hold is a shared run", () => {
    const seen = emptyCensus();
    const both = { ...emptyDump(), runs: [run("r1")] };
    noteOp(seen, { [A]: both, [B]: both }, { t: "readSteps", slug: B, runId: "r1" });
    expect(seen.sharedRuns).toBe(1);
    expect(seen.foreignRunReads).toBe(0);
  });

  test("a terminal setStatus counts only when the CAS passes and the neighbour holds a hook", () => {
    const dumps = {
      [A]: { ...emptyDump(), runs: [run("r1")] },
      [B]: { ...emptyDump(), runs: [run("r1")], hooks: [hook("r1", "tok")] },
    };
    const terminal = (expect: readonly string[] | undefined, status = "completed") => {
      const seen = emptyCensus();
      noteOp(seen, dumps, {
        t: "setStatus",
        slug: A,
        runId: "r1",
        status,
        result: undefined,
        expect,
      });
      return seen.terminalWithForeignHook;
    };
    expect(terminal(undefined)).toBe(1);
    expect(terminal(["running"])).toBe(1);
    // The compare-and-set fails, so nothing is released.
    expect(terminal(["pending"])).toBe(0);
    // Not terminal, so the release CTE does not run.
    expect(terminal(undefined, "running")).toBe(0);
  });

  test("a delivery for a token only the neighbour can still take is counted", () => {
    const seen = emptyCensus();
    noteOp(
      seen,
      { [A]: emptyDump(), [B]: { ...emptyDump(), hooks: [hook("r9", "tok")] } },
      {
        t: "deliverHook",
        slug: A,
        token: "tok",
        payload: undefined,
      },
    );
    expect(seen.foreignTokenDeliveries).toBe(1);
  });

  test("refusals are counted, answers are not", () => {
    const seen = emptyCensus();
    noteAnswer(seen, { ok: null });
    noteAnswer(seen, { refused: "hook-token", holder: "r1" });
    expect(seen.refusals).toBe(1);
  });
});
