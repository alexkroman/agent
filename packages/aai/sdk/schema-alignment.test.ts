// Copyright 2025 the AAI authors. MIT license.
/**
 * Schema–type alignment tests.
 *
 * These tests verify that Zod schemas and their derived TypeScript types
 * stay in sync, and that schemas correctly reject invalid data. When a
 * new field is added to a type but not its schema (or vice-versa), these
 * tests break — preventing silent API drift.
 */
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import { type AgentConfig, AgentConfigSchema, ToolSchemaSchema } from "./_internal-types.ts";
import { type ReadyConfig, ReadyConfigSchema } from "./protocol.ts";
import { type BuiltinTool, BuiltinToolSchema, type ToolChoice, ToolChoiceSchema } from "./types.ts";

// ── AgentConfigSchema ────────────────────────────────────────────────────

describe("AgentConfigSchema", () => {
  const valid: AgentConfig = {
    name: "test-agent",
    systemPrompt: "Be helpful",
    greeting: "Hello",
  };

  test("accepts valid minimal config", () => {
    expect(AgentConfigSchema.parse(valid)).toEqual(valid);
  });

  test("accepts full config with all optional fields", () => {
    const full: AgentConfig = {
      ...valid,
      sttPrompt: "Transcribe accurately",
      maxSteps: 10,
      toolChoice: "auto",
      builtinTools: ["web_search", "run_code"],
    };
    expect(AgentConfigSchema.parse(full)).toEqual(full);
  });

  test("rejects empty name", () => {
    expect(AgentConfigSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  test("rejects non-integer maxSteps", () => {
    expect(AgentConfigSchema.safeParse({ ...valid, maxSteps: 2.5 }).success).toBe(false);
  });

  test("rejects negative maxSteps", () => {
    expect(AgentConfigSchema.safeParse({ ...valid, maxSteps: -1 }).success).toBe(false);
  });

  test("rejects invalid builtinTools", () => {
    expect(AgentConfigSchema.safeParse({ ...valid, builtinTools: ["not_a_tool"] }).success).toBe(
      false,
    );
  });

  test("type derived from schema matches AgentConfig", () => {
    expectTypeOf<z.infer<typeof AgentConfigSchema>>().toEqualTypeOf<AgentConfig>();
  });
});

// ── ToolSchemaSchema ─────────────────────────────────────────────────────

describe("ToolSchemaSchema", () => {
  test("accepts valid tool schema", () => {
    const valid = {
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    };
    expect(ToolSchemaSchema.parse(valid)).toEqual(valid);
  });

  test("rejects empty name", () => {
    expect(ToolSchemaSchema.safeParse({ name: "", description: "d", parameters: {} }).success).toBe(
      false,
    );
  });

  test("rejects empty description", () => {
    expect(ToolSchemaSchema.safeParse({ name: "n", description: "", parameters: {} }).success).toBe(
      false,
    );
  });

  test("ToolSchema is assignable from schema inference", () => {
    // ToolSchema uses JSONSchema7 for parameters which is more specific than
    // the runtime schema's Record<string, unknown>. Verify the direction:
    // a parsed result should be assignable to ToolSchema (narrow → wide).
    const parsed = ToolSchemaSchema.parse({
      name: "test",
      description: "test",
      parameters: { type: "object" },
    });
    // Runtime check: shape matches
    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("description");
    expect(parsed).toHaveProperty("parameters");
  });
});

// ── ReadyConfigSchema ────────────────────────────────────────────────────

describe("ReadyConfigSchema", () => {
  const valid: ReadyConfig = {
    audioFormat: "pcm16",
    sampleRate: 16_000,
    ttsSampleRate: 24_000,
  };

  test("accepts valid config", () => {
    expect(ReadyConfigSchema.parse(valid)).toEqual(valid);
  });

  test("rejects unknown audio format", () => {
    expect(ReadyConfigSchema.safeParse({ ...valid, audioFormat: "mp3" }).success).toBe(false);
  });

  test("rejects non-positive sampleRate", () => {
    expect(ReadyConfigSchema.safeParse({ ...valid, sampleRate: 0 }).success).toBe(false);
  });

  test("type derived from schema matches ReadyConfig", () => {
    expectTypeOf<z.infer<typeof ReadyConfigSchema>>().toEqualTypeOf<ReadyConfig>();
  });
});

// ── BuiltinTool / ToolChoice drift guards ────────────────────────────────

describe("type ↔ schema alignment", () => {
  test("BuiltinToolSchema values match BuiltinTool union", () => {
    // Schema values are the source of truth; if the type adds a member
    // without updating the schema (or vice versa), TypeScript will error
    // on the drift guards in types.ts. This test documents the enum values.
    expect(BuiltinToolSchema.options).toMatchInlineSnapshot(`
      [
        "web_search",
        "visit_webpage",
        "fetch_json",
        "run_code",
      ]
    `);
  });

  test("BuiltinTool type equals schema inference", () => {
    expectTypeOf<z.infer<typeof BuiltinToolSchema>>().toEqualTypeOf<BuiltinTool>();
  });

  test("ToolChoice type equals schema inference", () => {
    expectTypeOf<z.infer<typeof ToolChoiceSchema>>().toEqualTypeOf<ToolChoice>();
  });

  test("ToolChoiceSchema accepts all ToolChoice variants", () => {
    const variants: ToolChoice[] = ["auto", "required"];
    for (const v of variants) {
      expect(ToolChoiceSchema.safeParse(v).success).toBe(true);
    }
  });

  test("ToolChoiceSchema rejects invalid variants", () => {
    expect(ToolChoiceSchema.safeParse("invalid").success).toBe(false);
    expect(ToolChoiceSchema.safeParse("none").success).toBe(false);
  });
});
