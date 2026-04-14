// Copyright 2025 the AAI authors. MIT license.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { parseManifest } from "./manifest.ts";

describe("parseManifest", () => {
  test("minimal manifest requires only name", () => {
    const result = parseManifest({ name: "Simple Agent" });
    expect(result).toEqual({
      name: "Simple Agent",
      systemPrompt: expect.any(String),
      greeting: expect.any(String),
      maxSteps: 5,
      toolChoice: "auto",
      builtinTools: [],
      tools: {},
    });
  });

  test("full manifest passes through all fields", () => {
    const input = {
      name: "Weather Agent",
      systemPrompt: "You are a weather bot.",
      greeting: "What city?",
      sttPrompt: "Celsius, Fahrenheit",
      builtinTools: ["web_search"],
      maxSteps: 10,
      toolChoice: "required" as const,
      idleTimeoutMs: 60_000,
      theme: { bg: "#000", primary: "#fff" },
      tools: {
        get_weather: {
          description: "Get weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    };
    const result = parseManifest(input);
    expect(result.name).toBe("Weather Agent");
    expect(result.systemPrompt).toBe("You are a weather bot.");
    expect(result.tools.get_weather?.description).toBe("Get weather");
    expect(result.maxSteps).toBe(10);
    expect(result.toolChoice).toBe("required");
  });

  test("rejects manifest without name", () => {
    expect(() => parseManifest({})).toThrow();
  });

  test("rejects unknown builtinTools", () => {
    expect(() => parseManifest({ name: "X", builtinTools: ["not_a_tool"] })).toThrow();
  });
});

// ── Property-based tests ─────────────────────────────────────────────────

describe("property: parseManifest", () => {
  test("valid manifests always parse", () => {
    const validManifestArb = fc.record({
      name: fc.string({ minLength: 1 }),
      systemPrompt: fc.option(fc.string(), { nil: undefined }),
      greeting: fc.option(fc.string(), { nil: undefined }),
      maxSteps: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
      toolChoice: fc.option(fc.constantFrom("auto" as const, "required" as const), {
        nil: undefined,
      }),
    });

    fc.assert(
      fc.property(validManifestArb, (manifest) => {
        const result = parseManifest(manifest);
        expect(result.name).toBe(manifest.name);
        expect(result.maxSteps).toBeGreaterThan(0);
        expect(["auto", "required"]).toContain(result.toolChoice);
      }),
    );
  });

  test("missing name throws", () => {
    // Generate objects that never have a `name` field
    const noNameArb = fc.record({
      systemPrompt: fc.option(fc.string(), { nil: undefined }),
      greeting: fc.option(fc.string(), { nil: undefined }),
      maxSteps: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    });

    fc.assert(
      fc.property(noNameArb, (obj) => {
        expect(() => parseManifest(obj)).toThrow();
      }),
    );
  });
});
