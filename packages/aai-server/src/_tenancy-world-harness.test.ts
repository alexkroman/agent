// Copyright 2026 the AAI authors. MIT license.
/**
 * The reference world and the partition check on HAND-WRITTEN programs, so each
 * divergence is one a reader can follow. `platform/tenancy.test.ts` runs the
 * same check over generated programs and every modelled leak.
 */

import { describe, expect, test } from "vitest";
import { emptyCensus, type Op } from "./_tenancy-ops-harness.ts";
import {
  checkPartition,
  createReferenceWorld,
  explain,
  isHookOp,
  isRunOp,
  isStepOp,
  isUploadOp,
} from "./_tenancy-world-harness.ts";

const A = "tenancy-alpha" as const;
const B = "tenancy-beta" as const;

const createRun = (slug: typeof A | typeof B, runId: string): Op => ({
  t: "createRun",
  slug,
  runId,
  workflow: "wf",
  input: undefined,
  createdAt: 1,
});

/** Both tenants run `r` and each holds a hook on it; then A finishes its run. */
const COLLIDING_RELEASE: readonly Op[] = [
  createRun(A, "r"),
  createRun(B, "r"),
  { t: "claimHook", slug: A, runId: "r", key: "h", token: "tokA" },
  { t: "claimHook", slug: B, runId: "r", key: "h", token: "tokB" },
  {
    t: "setStatus",
    slug: A,
    runId: "r",
    status: "completed",
    result: undefined,
    expect: undefined,
  },
];

describe("createReferenceWorld", () => {
  test("two tenants may hold the same run id independently", async () => {
    const world = createReferenceWorld();
    await expect(world.apply(createRun(A, "r"))).resolves.toEqual({ ok: undefined });
    await expect(world.apply(createRun(B, "r"))).resolves.toEqual({ ok: undefined });
    const dumps = await world.dumpAll();
    expect(dumps[A].runs.map((r) => r.runId)).toEqual(["r"]);
    expect(dumps[B].runs.map((r) => r.runId)).toEqual(["r"]);
  });

  test("reset empties both tenants", async () => {
    const world = createReferenceWorld();
    await world.apply(createRun(A, "r"));
    await world.reset();
    expect((await world.dumpAll())[A].runs).toEqual([]);
  });
});

describe("checkPartition", () => {
  test("the reference agrees with itself", async () => {
    await expect(
      checkPartition(createReferenceWorld(), COLLIDING_RELEASE, emptyCensus()),
    ).resolves.toBeUndefined();
  });

  test("a slug-blind store diverges at its FIRST write, in the neighbour's rows", async () => {
    const bad = await checkPartition(
      createReferenceWorld("flat"),
      COLLIDING_RELEASE,
      emptyCensus(),
    );
    expect(bad).toMatchObject({ at: 0, what: `tenant ${B}'s rows` });
  });

  test("a read that falls through to the neighbour diverges on the ANSWER", async () => {
    const bad = await checkPartition(
      createReferenceWorld("run-read"),
      [createRun(B, "r"), { t: "getRun", slug: A, runId: "r" }],
      emptyCensus(),
    );
    expect(bad).toMatchObject({ at: 1, what: "answered", expected: { ok: undefined } });
  });

  test("a release that loses its slug diverges on the NEIGHBOUR's rows, unread", async () => {
    const seen = emptyCensus();
    const bad = await checkPartition(createReferenceWorld("hook-release"), COLLIDING_RELEASE, seen);
    expect(bad).toMatchObject({ at: 4, what: `tenant ${B}'s rows` });
    // And the census saw the state the leak needs.
    expect(seen.terminalWithForeignHook).toBe(1);
  });

  test("explain names the op, the tenant and both values", async () => {
    const bad = await checkPartition(
      createReferenceWorld("flat"),
      COLLIDING_RELEASE,
      emptyCensus(),
    );
    if (!bad) throw new Error("expected a divergence");
    expect(explain(bad)).toMatch(
      /^op 0 \(createRun on tenancy-alpha\) — tenant tenancy-beta's rows outside its tenant\.\n/,
    );
    expect(explain(bad)).toContain('"runId":"r"');
  });
});

describe("op families", () => {
  test("each op belongs to exactly one family, or to the session family by default", () => {
    const ops: Op[] = [
      createRun(A, "r"),
      { t: "claimAttempt", slug: A, runId: "r", key: "k", holder: "w" },
      { t: "closeHook", slug: A, runId: "r", key: "h" },
      { t: "readUpload", slug: A, id: "u" },
      { t: "loadSlots", slug: A, sessionId: "s" },
    ];
    expect(ops.map((op) => [isRunOp(op), isStepOp(op), isHookOp(op), isUploadOp(op)])).toEqual([
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
      [false, false, false, true],
      [false, false, false, false],
    ]);
  });
});
