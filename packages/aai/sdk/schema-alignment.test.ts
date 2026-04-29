// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import { type AgentConfig, AgentConfigSchema, ToolSchemaSchema } from "./_internal-types.ts";
import { type ReadyConfig, ReadyConfigSchema } from "./protocol.ts";
import { type BuiltinTool, BuiltinToolSchema, type ToolChoice, ToolChoiceSchema } from "./types.ts";

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

  test.each([
    ["empty name", { name: "" }],
    ["non-integer maxSteps", { maxSteps: 2.5 }],
    ["negative maxSteps", { maxSteps: -1 }],
    ["invalid builtinTools", { builtinTools: ["not_a_tool"] }],
  ])("rejects %s", (_label, override) => {
    expect(AgentConfigSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  test("type derived from schema matches AgentConfig", () => {
    expectTypeOf<z.infer<typeof AgentConfigSchema>>().toEqualTypeOf<AgentConfig>();
  });
});

describe("ToolSchemaSchema", () => {
  const base = { type: "function" as const, name: "n", description: "d", parameters: {} };

  test("accepts valid tool schema", () => {
    const valid = {
      type: "function" as const,
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    };
    expect(ToolSchemaSchema.parse(valid)).toEqual(valid);
  });

  test.each([
    ["empty name", { name: "" }],
    ["empty description", { description: "" }],
  ])("rejects %s", (_label, override) => {
    expect(ToolSchemaSchema.safeParse({ ...base, ...override }).success).toBe(false);
  });

  test("ToolSchema is assignable from schema inference", () => {
    // ToolSchema uses JSONSchema7 for parameters (narrower than the runtime
    // Record<string, unknown>); verify a parsed result satisfies the wider shape.
    const parsed = ToolSchemaSchema.parse({
      type: "function",
      name: "test",
      description: "test",
      parameters: { type: "object" },
    });
    expect(parsed).toHaveProperty("name");
    expect(parsed).toHaveProperty("description");
    expect(parsed).toHaveProperty("parameters");
  });
});

describe("ReadyConfigSchema", () => {
  const valid: ReadyConfig = {
    audioFormat: "pcm16",
    sampleRate: 16_000,
    ttsSampleRate: 24_000,
  };

  test("accepts valid config", () => {
    expect(ReadyConfigSchema.parse(valid)).toEqual(valid);
  });

  test.each([
    ["unknown audio format", { audioFormat: "mp3" }],
    ["non-positive sampleRate", { sampleRate: 0 }],
  ])("rejects %s", (_label, override) => {
    expect(ReadyConfigSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  test("type derived from schema matches ReadyConfig", () => {
    expectTypeOf<z.infer<typeof ReadyConfigSchema>>().toEqualTypeOf<ReadyConfig>();
  });
});

describe("type ↔ schema alignment", () => {
  test("BuiltinToolSchema values match BuiltinTool union", () => {
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

  test.each<ToolChoice>(["auto", "required"])("ToolChoiceSchema accepts %s", (v) => {
    expect(ToolChoiceSchema.safeParse(v).success).toBe(true);
  });

  test.each(["invalid", "none"])("ToolChoiceSchema rejects %s", (v) => {
    expect(ToolChoiceSchema.safeParse(v).success).toBe(false);
  });
});
