// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { validatedBy } from "./_testing-schema-check.ts";

describe("validatedBy", () => {
  test("hands back what the schema produced", async () => {
    const schema = z.object({ n: z.coerce.number() });
    expect(await validatedBy(schema, { n: "3" }, () => "unused")).toEqual({ n: 3 });
  });

  test("throws the caller's sentence over the issues, rendered as one line", async () => {
    const schema = z.object({ n: z.number() });
    await expect(
      validatedBy(schema, { n: "nope" }, (issues) => `refused: ${issues}`),
    ).rejects.toThrow(/^refused: n: .+$/);
  });
});
