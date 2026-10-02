// Copyright 2026 the AAI authors. MIT license.
// The SDK-derived half of the studio preamble (studio-preamble-sdk.ts): the
// values it interpolates from the SDK and the model roster.

import { ASSEMBLYAI_LLM_DEFAULT_MODEL } from "@alexkroman1/aai/llm";
import { describe, expect, test } from "vitest";
import { STUDIO_LLM_MODELS } from "../studio-llm.ts";
import { STUDIO_SDK_GUIDANCE } from "./studio-preamble-sdk.ts";

describe("STUDIO_SDK_GUIDANCE", () => {
  test("names every gateway model in the roster, so the agent cannot invent one", () => {
    // Floored: an empty roster would satisfy the filter vacuously.
    expect(STUDIO_LLM_MODELS.length).toBeGreaterThan(1);
    expect(STUDIO_LLM_MODELS.filter((model) => !STUDIO_SDK_GUIDANCE.includes(model))).toEqual([]);
  });

  test("defaults generated agents to the SDK's own default model", () => {
    expect(STUDIO_SDK_GUIDANCE).toContain(
      `"${ASSEMBLYAI_LLM_DEFAULT_MODEL}" unless the user asks for a different model`,
    );
  });

  test("opens at the data section and says there is no ctx.db", () => {
    expect(STUDIO_SDK_GUIDANCE.startsWith("## Data Persistence and Storage")).toBe(true);
    expect(STUDIO_SDK_GUIDANCE).toContain("THERE IS NO `ctx.db`");
  });

  test("carries no mode-specific product-shape section — that is the mode's to swap", () => {
    expect(STUDIO_SDK_GUIDANCE).not.toContain("## Voice Agents and Workflow Apps");
    expect(STUDIO_SDK_GUIDANCE).not.toContain("Default to a VOICE agent");
  });
});
