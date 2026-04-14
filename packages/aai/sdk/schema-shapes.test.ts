// Copyright 2025 the AAI authors. MIT license.
/**
 * Schema shape snapshot tests for public Zod schemas.
 *
 * These tests snapshot the field names of public schemas exported from
 * `@alexkroman1/aai/protocol` and `@alexkroman1/aai/manifest`. A breaking
 * snapshot signals a wire-format change (field additions, removals, or renames)
 * that may require a changeset and protocol-version bump.
 *
 * For discriminated unions (ClientEventSchema, ServerMessageSchema,
 * ClientMessageSchema), each option's shape keys are keyed by its
 * discriminator value. For object schemas (AgentConfigSchema,
 * ToolSchemaSchema), the top-level shape keys are snapshotted directly.
 */
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
  TurnConfigSchema,
} from "./protocol.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

type ZodObjectLike = { shape: Record<string, unknown> };

/**
 * Extract shape keys (field names) from a ZodObject-like schema.
 */
function shapeKeys(schema: ZodObjectLike): string[] {
  return Object.keys(schema.shape).sort();
}

/**
 * Extract a map of { discriminatorValue → sorted shape keys } from a
 * ZodDiscriminatedUnion. The discriminator literal may be a single value
 * or an array (Zod v4 stores it as `.values`).
 */
function discriminatedUnionShapes(schema: {
  options: Array<{ shape: Record<string, unknown> }>;
}): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const option of schema.options) {
    const typeSchema = option.shape?.type as
      | { _def?: { value?: string; values?: string[] } }
      | undefined;
    const def = typeSchema?._def;
    // Zod v4 uses `.values` (array); Zod v3 uses `.value` (scalar)
    const raw = def?.values ?? def?.value;
    const discriminatorValue = Array.isArray(raw) ? raw[0] : raw;
    const key = String(discriminatorValue ?? "unknown");
    result[key] = Object.keys(option.shape).sort();
  }
  return result;
}

// ── Protocol schemas ─────────────────────────────────────────────────────

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

  test("TurnConfigSchema shape", () => {
    expect(shapeKeys(TurnConfigSchema)).toMatchSnapshot();
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

// ── Manifest schemas ──────────────────────────────────────────────────────

describe("manifest schema shapes", () => {
  test("AgentConfigSchema shape", () => {
    expect(shapeKeys(AgentConfigSchema)).toMatchSnapshot();
  });

  test("ToolSchemaSchema shape", () => {
    expect(shapeKeys(ToolSchemaSchema)).toMatchSnapshot();
  });
});
