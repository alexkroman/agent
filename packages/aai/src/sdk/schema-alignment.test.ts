// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import {
  type AgentConfig,
  AgentConfigSchema,
  type ToolSchema,
  ToolSchemaSchema,
} from "./_internal-types.ts";
import { type ReadyConfig, ReadyConfigSchema } from "./protocol.ts";
import { BuiltinToolSchema, ToolChoiceSchema, type VoicePresetNameSchema } from "./type-schemas.ts";
import type { BuiltinTool, ToolChoice, VoicePresetName } from "./types.ts";

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
    // An EMPTY name, not an unknown one: `BuiltinTool` is open, so an unknown
    // builtin parses and is warned about by `agentConfigWarnings` instead.
    ["an empty builtinTools entry", { builtinTools: [""] }],
    ["a non-string builtinTools entry", { builtinTools: [42] }],
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
    // ToolSchema uses JSONSchema7 for `parameters`, where the schema infers
    // `Record<string, unknown>` — so the claim is a TYPE one and has to be made
    // at the type level. Three `toHaveProperty` calls on a value zod had just
    // parsed with those three keys could not fail without the parse test above
    // failing first, and narrowing `ToolSchema["parameters"]` past what a parse
    // result satisfies went straight through them.
    const parsed = ToolSchemaSchema.parse({
      type: "function",
      name: "test",
      description: "test",
      parameters: { type: "object" },
    });
    // `toExtend` rather than `toMatchObjectType`, and `messages` is why: an
    // optional OBJECT-typed property defeats that matcher's deep brand, which
    // then blames `parameters` for a mismatch that is not there. The same trap
    // is why `sdk/tool-messages.ts` declares its four message types FLAT
    // instead of intersecting a shared base — see "`toMatchObjectType` silently
    // degrades on a type with an optional OBJECT-typed property" in
    // `.agents/testing.md` before adding an assertion here.
    expectTypeOf(parsed).toExtend<ToolSchema>();
    expectTypeOf<z.infer<typeof ToolSchemaSchema>>().toExtend<ToolSchema>();
    expect(parsed.parameters).toEqual({ type: "object" });
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
        "get_page_design",
        "fetch_json",
        "run_code",
        "think",
        "remember",
        "recall",
        "calculate",
      ]
    `);
  });

  test("BuiltinTool is OPEN: the shipped enum plus any string, and the config schema accepts it", () => {
    // The enum is the closed set THIS release ships; the published type writes
    // the same names inline as its autocomplete half, then opens.
    expectTypeOf<z.infer<typeof BuiltinToolSchema> | (string & {})>().toEqualTypeOf<BuiltinTool>();
    expectTypeOf<"a_later_builtin">().toExtend<BuiltinTool>();
    const config = { name: "a", systemPrompt: "p", greeting: "g" };
    for (const builtinTools of [["think"], ["a_later_builtin"]]) {
      expect(AgentConfigSchema.safeParse({ ...config, builtinTools }).success).toBe(true);
    }
    expect(AgentConfigSchema.safeParse({ ...config, builtinTools: [""] }).success).toBe(false);
  });

  test("AgentConfigSchema accepts an unknown telephony carrier (it is warned about, not refused)", () => {
    const config = { name: "a", systemPrompt: "p", greeting: "g" };
    for (const telephony of [true, ["twilio"], ["a-later-carrier"]]) {
      expect(AgentConfigSchema.safeParse({ ...config, telephony }).success).toBe(true);
    }
    expect(AgentConfigSchema.safeParse({ ...config, telephony: [""] }).success).toBe(false);
  });

  test("ToolChoice type equals schema inference", () => {
    expectTypeOf<z.infer<typeof ToolChoiceSchema>>().toEqualTypeOf<ToolChoice>();
  });

  test("VoicePresetName is OPEN, and the schema accepts what the type does", () => {
    // Known names autocomplete; any other string compiles and parses, and is
    // warned about at build time rather than refused (`agentConfigWarnings`).
    expectTypeOf<"echoVerification">().toExtend<VoicePresetName>();
    expectTypeOf<"a-later-preset">().toExtend<VoicePresetName>();
    expectTypeOf<z.infer<typeof VoicePresetNameSchema>>().toEqualTypeOf<string>();
  });

  test("AgentConfigSchema accepts an unknown preset name (it is warned about, not refused)", () => {
    const config = { name: "a", systemPrompt: "p", greeting: "g" };
    for (const voicePresets of [["natoAlphabet"], ["a-later-preset"]]) {
      expect(AgentConfigSchema.safeParse({ ...config, voicePresets }).success).toBe(true);
    }
    expect(AgentConfigSchema.safeParse({ ...config, voicePresets: [""] }).success).toBe(false);
  });

  test.each<ToolChoice>(["auto", "required", "none", { type: "tool", toolName: "get_weather" }])(
    "ToolChoiceSchema accepts %j",
    (v) => {
      expect(ToolChoiceSchema.safeParse(v).success).toBe(true);
    },
  );

  test.each(["invalid", { type: "tool" }, { type: "tool", toolName: "" }])(
    "ToolChoiceSchema rejects %j",
    (v) => {
      expect(ToolChoiceSchema.safeParse(v).success).toBe(false);
    },
  );
});
