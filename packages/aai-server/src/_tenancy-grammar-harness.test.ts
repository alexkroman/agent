// Copyright 2026 the AAI authors. MIT license.

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { label, PROLOGUE, programArb, SLUGS } from "./_tenancy-grammar-harness.ts";
import type { Op } from "./_tenancy-ops-harness.ts";

/** The run ids `createRun` plants under `slug` in the prologue. */
const createdBy = (slug: string): string[] =>
  PROLOGUE.flatMap((op) => (op.t === "createRun" && op.slug === slug ? [op.runId] : []));

describe("the tenancy grammar", () => {
  test("two distinct tenants", () => {
    expect(new Set(SLUGS).size).toBe(2);
  });

  test("the prologue plants a COLLIDING run under both tenants and a lopsided one each", () => {
    const [a, b] = SLUGS;
    const mine = createdBy(a);
    const theirs = createdBy(b);
    expect(mine.filter((id) => theirs.includes(id)).length).toBeGreaterThan(0);
    expect(mine.some((id) => !theirs.includes(id))).toBe(true);
    expect(theirs.some((id) => !mine.includes(id))).toBe(true);
  });

  test("label stamps every ordering key with a distinct increasing value", () => {
    const ops: Op[] = [
      {
        t: "createRun",
        slug: "tenancy-alpha",
        runId: "r",
        workflow: "w",
        input: undefined,
        createdAt: 0,
      },
      { t: "getRun", slug: "tenancy-alpha", runId: "r" },
      {
        t: "appendStep",
        slug: "tenancy-beta",
        runId: "r",
        key: "k",
        status: "ok",
        output: undefined,
        finishedAt: 0,
      },
    ];
    const stamped = label(ops);
    expect(stamped[0]).toMatchObject({ createdAt: 1 });
    expect(stamped[1]).toBe(ops[1]);
    expect(stamped[2]).toMatchObject({ finishedAt: 2 });
    // The input is left alone.
    expect(ops[0]).toMatchObject({ createdAt: 0 });
  });

  test("every generated program starts from the prologue and stays inside the two tenants", () => {
    fc.assert(
      fc.property(programArb, (program) => {
        expect(program.length).toBeGreaterThan(PROLOGUE.length);
        expect(program.slice(0, PROLOGUE.length).map((op) => op.t)).toEqual(
          PROLOGUE.map((op) => op.t),
        );
        for (const op of program) expect(SLUGS).toContain(op.slug);
      }),
      { numRuns: 25 },
    );
  });
});
