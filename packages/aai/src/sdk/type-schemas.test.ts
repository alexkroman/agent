// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test } from "vitest";
import type { z } from "zod";
import {
  BuiltinToolNameSchema,
  BuiltinToolSchema,
  TelephonyCarrierNameSchema,
  ToolChoiceSchema,
  VoicePresetNameSchema,
} from "./type-schemas.ts";
import type { ToolChoice, VoicePresetName } from "./types.ts";

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
        "open_meteo",
        "brave_search",
        "google_places",
        "text_me",
      ]
    `);
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

  test.each([BuiltinToolNameSchema, TelephonyCarrierNameSchema, VoicePresetNameSchema])(
    "an OPEN name schema accepts any non-empty string and refuses the empty one",
    (schema) => {
      expect(schema.safeParse("a-later-name").success).toBe(true);
      expect(schema.safeParse("").success).toBe(false);
    },
  );
});
