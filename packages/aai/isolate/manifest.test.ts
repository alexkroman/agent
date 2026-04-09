// Copyright 2025 the AAI authors. MIT license.
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
      hooks: {
        onConnect: false,
        onDisconnect: false,
        onUserTranscript: false,
        onError: false,
      },
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
      hooks: {
        onConnect: true,
        onDisconnect: false,
        onUserTranscript: true,
        onError: false,
      },
    };
    const result = parseManifest(input);
    expect(result.name).toBe("Weather Agent");
    expect(result.systemPrompt).toBe("You are a weather bot.");
    expect(result.tools.get_weather?.description).toBe("Get weather");
    expect(result.hooks.onConnect).toBe(true);
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
