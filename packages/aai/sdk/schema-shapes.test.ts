// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { AgentConfigSchema, ToolSchemaSchema } from "./_internal-types.ts";
import {
  ClientEventSchema,
  ClientMessageSchema,
  KvDelSchema,
  KvGetSchema,
  KvSetSchema,
  ReadyConfigSchema,
  ServerMessageSchema,
} from "./protocol.ts";

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

describe("protocol schema shapes", () => {
  test("ClientEventSchema option shapes", () => {
    expect(discriminatedUnionShapes(ClientEventSchema)).toMatchSnapshot();
  });

  test("ServerMessageSchema option shapes", () => {
    expect(discriminatedUnionShapes(ServerMessageSchema)).toMatchSnapshot();
  });

  test("ClientMessageSchema option shapes", () => {
    expect(discriminatedUnionShapes(ClientMessageSchema)).toMatchSnapshot();
  });

  test("ReadyConfigSchema shape", () => {
    expect(shapeKeys(ReadyConfigSchema)).toMatchSnapshot();
  });

  test("KvGetSchema shape", () => {
    expect(shapeKeys(KvGetSchema)).toMatchSnapshot();
  });

  test("KvSetSchema shape", () => {
    expect(shapeKeys(KvSetSchema)).toMatchSnapshot();
  });

  test("KvDelSchema shape", () => {
    expect(shapeKeys(KvDelSchema)).toMatchSnapshot();
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
