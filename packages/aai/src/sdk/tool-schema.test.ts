// Copyright 2026 the AAI authors. MIT license.
/**
 * What the WIRE form of a tool promises, asserted beside the module that
 * declares it.
 *
 * `schema-alignment.test.ts` covers the type↔schema correspondence and
 * `schema-shapes.test.ts` snapshots the key set; neither states the property
 * this module exists for, which is what an ABSENT classification means. Those
 * two would both stay green if `mutates` gained a `.default(false)`.
 */

import { describe, expect, test } from "vitest";

import { ToolSchemaSchema } from "./tool-schema.ts";

const base = {
  type: "function" as const,
  name: "refund_order",
  description: "Refund an order.",
  parameters: { type: "object" as const },
};

describe("ToolSchemaSchema classification fields", () => {
  test("an undeclared tool carries NEITHER key — absent is not `false`", () => {
    // The load-bearing property. `ToolDef.mutates`' doc says absent means "not
    // declared", never "read-only", and the two-tier gate logs those tools
    // rather than un-gating them. A `.default(false)` here would turn every
    // tool written before the field existed into a declared read, silently,
    // and the shape snapshot beside this file would not move.
    const parsed = ToolSchemaSchema.parse(base);
    expect("mutates" in parsed).toBe(false);
    expect("completes" in parsed).toBe(false);
  });

  test("both classifications round-trip when declared", () => {
    const declared = { ...base, mutates: true, completes: true };
    expect(ToolSchemaSchema.parse(declared)).toEqual(declared);
  });

  test("`mutates: false` is preserved as an explicit read declaration", () => {
    // Distinct from absence above: an author who wrote `false` said something,
    // and dropping it would collapse the two states the gate tells apart.
    const parsed = ToolSchemaSchema.parse({ ...base, mutates: false });
    expect(parsed.mutates).toBe(false);
  });

  test.each([
    ["a non-boolean mutates", { mutates: "yes" }],
    ["a non-boolean completes", { completes: 1 }],
  ])("rejects %s", (_label, override) => {
    expect(ToolSchemaSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });

  test("the three optional fields are independent", () => {
    // `messages` arrived with tool-call speech and the pair with the fast/slow
    // split; a tool may declare any one without the others.
    const speechOnly = { ...base, messages: { start: [{ content: "One moment." }] } };
    expect(ToolSchemaSchema.parse(speechOnly)).toEqual(speechOnly);

    const gateOnly = { ...base, completes: true };
    const parsed = ToolSchemaSchema.parse(gateOnly);
    expect("messages" in parsed).toBe(false);
    expect(parsed.completes).toBe(true);
  });
});
