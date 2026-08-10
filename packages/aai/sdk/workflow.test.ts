// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  DEFAULT_STEP_BACKOFF_MS,
  DEFAULT_STEP_MAX_ATTEMPTS,
  MAX_WORKFLOW_STEPS,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
  workflow,
} from "./workflow.ts";

describe("workflow()", () => {
  test("returns its definition unchanged", () => {
    const def = {
      description: "d",
      input: z.object({ topic: z.string() }),
      run: () => "out",
    };
    expect(workflow(def)).toBe(def);
  });

  test("accepts a definition with no schema and no description", () => {
    const def = workflow({ run: () => undefined });
    expect(def.input).toBeUndefined();
    expect(def.description).toBeUndefined();
  });
});

describe("WORKFLOWS_UNAVAILABLE_MESSAGE", () => {
  test("names both halves an author could be missing", () => {
    // The two causes are different fixes, and a message naming only one sends
    // an author who declared workflows off to check their agent definition.
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("agent({ workflows })");
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("aai storage enable");
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("DATABASE_URL");
  });
});

describe("defaults", () => {
  test("retry defaults are bounded and positive", () => {
    expect(DEFAULT_STEP_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_STEP_BACKOFF_MS).toBeGreaterThan(0);
  });

  test("the step cap stays under the db row cap it exists to respect", async () => {
    // Replay reads the journal through `ctx.db`, which throws past
    // MAX_DB_RESULT_ROWS — a cap above it would make a long run unreplayable,
    // which is the silent duplicate-side-effect bug the constant prevents.
    const { MAX_DB_RESULT_ROWS } = await import("./db.ts");
    expect(MAX_WORKFLOW_STEPS).toBeLessThanOrEqual(MAX_DB_RESULT_ROWS);
  });
});
