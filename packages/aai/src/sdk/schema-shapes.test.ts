// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { AgentConfigSchema, ToolSchemaSchema } from "./_internal-types.ts";
import { ReadyConfigSchema, SessionCommandSchema, SessionEventSchema } from "./protocol.ts";

type ZodObjectLike = { shape: Record<string, unknown> };

function shapeKeys(schema: ZodObjectLike): string[] {
  return Object.keys(schema.shape).sort();
}

function discriminatedUnionShapes(schema: {
  options: Array<{ shape: Record<string, unknown> }>;
}): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const option of schema.options) {
    const typeSchema = option.shape?.type as
      | { _def?: { value?: string; values?: string[] } }
      | undefined;
    // Zod v4 uses `.values` (array); Zod v3 uses `.value` (scalar)
    const raw = typeSchema?._def?.values ?? typeSchema?._def?.value;
    const discriminatorValue = Array.isArray(raw) ? raw[0] : raw;
    const key = String(discriminatorValue ?? "unknown");
    result[key] = Object.keys(option.shape).sort();
  }
  return result;
}

// The two unions, named as they are DECLARED. The direction-named aliases
// (`ServerMessageSchema`, `ClientMessageSchema`) are gone,
// and this file used to snapshot both sides of the first one — the same object,
// twice, identical by construction. Naming the declarations also stops the
// aliases reading as load-bearing.
describe("protocol schema shapes", () => {
  test("SessionEventSchema option shapes", () => {
    expect(discriminatedUnionShapes(SessionEventSchema)).toMatchSnapshot();
  });

  test("SessionCommandSchema option shapes", () => {
    expect(discriminatedUnionShapes(SessionCommandSchema)).toMatchSnapshot();
  });

  test("ReadyConfigSchema shape", () => {
    expect(shapeKeys(ReadyConfigSchema)).toMatchSnapshot();
  });
});

describe("manifest schema shapes", () => {
  test("AgentConfigSchema shape", () => {
    expect(shapeKeys(AgentConfigSchema)).toMatchSnapshot();
  });

  test("ToolSchemaSchema shape", () => {
    expect(shapeKeys(ToolSchemaSchema)).toMatchSnapshot();
  });
});
