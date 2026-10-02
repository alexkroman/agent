// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { llm } from "../llm.ts";
import { normalizeLlm } from "./from-string.ts";

describe("normalizeLlm", () => {
  test("passes a descriptor, and an absent value, through untouched", () => {
    const descriptor = llm({ provider: "gateway", model: "openai/gpt-x" });
    expect(normalizeLlm(descriptor)).toBe(descriptor);
    expect(normalizeLlm(undefined)).toBeUndefined();
  });

  test("a bare model id is the AssemblyAI provider", () => {
    expect(normalizeLlm("claude-x")).toEqual(llm({ provider: "assemblyai", model: "claude-x" }));
  });

  test("a `creator/model` id is the gateway", () => {
    expect(normalizeLlm("openai/gpt-x")).toEqual(
      llm({ provider: "gateway", model: "openai/gpt-x" }),
    );
  });

  test("answers ONE descriptor per model id, so re-normalizing a config is stable", () => {
    expect(normalizeLlm("claude-y")).toBe(normalizeLlm("claude-y"));
  });
});
