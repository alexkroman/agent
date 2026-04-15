// Copyright 2025 the AAI authors. MIT license.
import fc from "fast-check";
import { describe, expect, expectTypeOf, test } from "vitest";
import { type Manifest, parseManifest } from "./manifest.ts";
import type { AgentConfig, ToolSchema } from "./manifest-barrel.ts";
import { agentToolsToSchemas, toAgentConfig } from "./manifest-barrel.ts";

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
      allowedHosts: [],
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

  test("allowedHosts defaults to empty array when omitted", () => {
    const result = parseManifest({ name: "test" });
    expect(result.allowedHosts).toEqual([]);
  });

  test("allowedHosts passes through valid patterns", () => {
    const result = parseManifest({
      name: "test",
      allowedHosts: ["api.weather.com", "*.mycompany.com"],
    });
    expect(result.allowedHosts).toEqual(["api.weather.com", "*.mycompany.com"]);
  });

  test("rejects invalid allowedHosts pattern", () => {
    expect(() => parseManifest({ name: "test", allowedHosts: ["*"] })).toThrow();
  });

  test("rejects allowedHosts with IP address", () => {
    expect(() => parseManifest({ name: "test", allowedHosts: ["192.168.1.1"] })).toThrow();
  });

  test("rejects allowedHosts with private TLD", () => {
    expect(() => parseManifest({ name: "test", allowedHosts: ["*.internal"] })).toThrow();
  });

  test("rejects allowedHosts with protocol", () => {
    expect(() =>
      parseManifest({ name: "test", allowedHosts: ["https://api.example.com"] }),
    ).toThrow();
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

describe("manifest type contracts", () => {
  test("parseManifest returns Manifest", () => {
    const result = parseManifest({ name: "test" });
    expectTypeOf(result).toEqualTypeOf<Manifest>();
  });

  test("parseManifest accepts unknown input", () => {
    expectTypeOf(parseManifest).parameter(0).toBeUnknown();
  });

  test("toAgentConfig returns AgentConfig", () => {
    const config = toAgentConfig({ name: "test", systemPrompt: "p", greeting: "g" });
    expectTypeOf(config).toEqualTypeOf<AgentConfig>();
  });

  test("agentToolsToSchemas returns ToolSchema[]", () => {
    const schemas = agentToolsToSchemas({});
    expectTypeOf(schemas).toEqualTypeOf<ToolSchema[]>();
  });

  test("Manifest has allowedHosts as string[]", () => {
    const result = parseManifest({ name: "test" });
    expectTypeOf(result.allowedHosts).toEqualTypeOf<string[]>();
  });
});
