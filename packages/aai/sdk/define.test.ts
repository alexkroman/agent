// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import { parseManifest } from "./manifest.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "./providers.ts";

describe("tool()", () => {
  test("returns the definition unchanged", () => {
    const def = tool({
      description: "Greet someone",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => `Hello, ${name}!`,
    });
    expect(def.description).toBe("Greet someone");
    expect(def.execute({ name: "Alice" }, {} as never)).toBe("Hello, Alice!");
  });

  test("works without parameters", () => {
    const def = tool({
      description: "No-param tool",
      execute: () => "done",
    });
    expect(def.description).toBe("No-param tool");
    expect(def.parameters).toBeUndefined();
  });
});

describe("agent()", () => {
  test("applies defaults", () => {
    const def = agent({ name: "Test Agent" });
    expect(def.name).toBe("Test Agent");
    expect(def.systemPrompt).toContain("You are AAI");
    expect(def.greeting).toContain("Hey there");
    expect(def.maxSteps).toBe(5);
    expect(def.tools).toEqual({});
  });

  test("preserves explicit values", () => {
    const greetTool = tool({
      description: "Greet",
      parameters: z.object({ name: z.string() }),
      execute: ({ name }) => `Hi ${name}`,
    });
    const def = agent({
      name: "Custom",
      systemPrompt: "Be nice.",
      greeting: "Hello!",
      maxSteps: 10,
      tools: { greet: greetTool },
      builtinTools: ["web_search"],
    });
    expect(def.systemPrompt).toBe("Be nice.");
    expect(def.greeting).toBe("Hello!");
    expect(def.maxSteps).toBe(10);
    expect(def.tools.greet).toBe(greetTool);
    expect(def.builtinTools).toEqual(["web_search"]);
  });

  test("preserves stt/llm/tts providers on the returned def", () => {
    const stt = { name: "fake-stt", open: async () => ({}) } as unknown as SttProvider;
    const tts = { name: "fake-tts", open: async () => ({}) } as unknown as TtsProvider;
    const llm = {} as LlmProvider;
    const def = agent({ name: "t", systemPrompt: "p", stt, llm, tts });
    expect(def.stt).toBe(stt);
    expect(def.llm).toBe(llm);
    expect(def.tts).toBe(tts);
  });

  test("stt/llm/tts flow through parseManifest to mode 'pipeline'", () => {
    const stt = { name: "fake-stt", open: async () => ({}) } as unknown as SttProvider;
    const tts = { name: "fake-tts", open: async () => ({}) } as unknown as TtsProvider;
    const llm = {} as LlmProvider;
    const def = agent({ name: "t", systemPrompt: "p", stt, llm, tts });
    const parsed = parseManifest(def);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toBe(stt);
    expect(parsed.llm).toBe(llm);
    expect(parsed.tts).toBe(tts);
  });

  test("agent without providers resolves to mode 's2s'", () => {
    const def = agent({ name: "t", systemPrompt: "p" });
    const parsed = parseManifest(def);
    expect(parsed.mode).toBe("s2s");
    expect(parsed.stt).toBeUndefined();
    expect(parsed.llm).toBeUndefined();
    expect(parsed.tts).toBeUndefined();
  });
});
