// Copyright 2026 the AAI authors. MIT license.
/**
 * What the WIRE form of a tool promises, asserted beside the module that
 * declares it.
 *
 * `schema-alignment.test.ts` covers the type↔schema correspondence and
 * `schema-shapes.test.ts` snapshots the key set; neither states what an
 * ABSENT optional field means, which is the property this file exists for and
 * the one every consumer of a stored declaration depends on.
 *
 * It replaces a version of this file whose every assertion was about
 * `mutates`/`completes` — the two classifications the fast/slow split added and
 * took away with it. Their removal is itself pinned below: the schema does not
 * REFUSE them, it strips them, so a tool declared against that SDK still
 * deploys and simply carries nothing.
 */

import { describe, expect, test } from "vitest";

import { ToolSchemaSchema } from "./tool-schema.ts";

const base = {
  type: "function" as const,
  name: "refund_order",
  description: "Refund an order.",
  parameters: { type: "object" as const },
};

describe("ToolSchemaSchema", () => {
  test("an ordinary tool's declaration round-trips with NO extra keys", () => {
    // The load-bearing property. `ToolSchema.messages`' doc promises that a
    // tool declaring no speech has a wire declaration byte-identical to what
    // it was before the field existed — so a `.default({})` here, or any
    // normalization that materializes the key, would change every stored
    // declaration in the fleet while this file's siblings stayed green.
    const parsed = ToolSchemaSchema.parse(base);
    expect(parsed).toEqual(base);
    expect("messages" in parsed).toBe(false);
  });

  test("declared messages round-trip", () => {
    const declared = { ...base, messages: { start: [{ content: "One moment." }] } };
    expect(ToolSchemaSchema.parse(declared)).toEqual(declared);
  });

  // The fast/slow split's two classifications. A declaration minted by an SDK
  // that still had them parses — the schema is not `.strict()` — and comes back
  // without them, which is what makes removing the feature a non-event for an
  // agent nobody has rebuilt. Rejecting them instead would take that agent off
  // the air at deploy time.
  test("the retired classification fields are STRIPPED, not refused", () => {
    const result = ToolSchemaSchema.safeParse({ ...base, mutates: true, completes: true });
    expect(result.success).toBe(true);
    expect(result.data).toEqual(base);
  });

  test.each([
    ["a missing name", { name: undefined }],
    ["an empty name", { name: "" }],
    ["an empty description", { description: "" }],
    ["a non-function type", { type: "tool" }],
    ["non-object parameters", { parameters: "object" }],
  ])("rejects %s", (_label, override) => {
    expect(ToolSchemaSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });
});
