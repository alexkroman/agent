// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { agent, tool } from "./define.ts";
import { parseManifest } from "./manifest.ts";
import { assemblyAIPipeline } from "./providers/assemblyai-pipeline.ts";
import { anthropic } from "./providers/llm/anthropic.ts";
import { assemblyAILlm } from "./providers/llm/assemblyai.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";
import { assemblyAITts } from "./providers/tts/assemblyai.ts";
import { cartesia } from "./providers/tts/cartesia.ts";

describe("tool()", () => {
  test("returns the definition unchanged", () => {
    const def = tool({
      description: "Greet someone",
      inputSchema: z.object({ name: z.string() }),
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
    expect(def.inputSchema).toBeUndefined();
  });
});

describe("agent()", () => {
  test("`system` is an alias of systemPrompt", () => {
    const def = agent({ name: "t", system: "You are terse." });
    expect(def.systemPrompt).toBe("You are terse.");
    expect("system" in def).toBe(false);
  });

  test("setting both `system` and `systemPrompt` throws", () => {
    expect(() => agent({ name: "t", system: "a", systemPrompt: "b" })).toThrow(/aliases/);
  });

  test("llm accepts a creator/model string and desugars to the Vercel AI Gateway", () => {
    // Alone, with no other pipeline stage declared — the missing stages are
    // filled from the default pipeline downstream.
    const def = agent({ name: "t", llm: "anthropic/claude-sonnet-4-5" });
    expect(def.llm).toEqual({ kind: "gateway", options: { model: "anthropic/claude-sonnet-4-5" } });
  });

  test("llm accepts a bare model id and desugars to the AssemblyAI LLM Gateway", () => {
    const def = agent({ name: "t", llm: "gpt-5.5" });
    expect(def.llm?.kind).toBe("assemblyai");
    expect(def.llm?.options.model).toBe("gpt-5.5");
  });

  test("llm descriptors pass through unchanged", () => {
    const llm = assemblyAILlm({ model: "gpt-5.5" });
    expect(agent({ name: "t", ...assemblyAIPipeline(), llm }).llm).toBe(llm);
  });

  test("applies defaults", () => {
    const def = agent({ name: "Test Agent" });
    expect(def.name).toBe("Test Agent");
    expect(def.systemPrompt).toContain("voice agent");
    expect(def.greeting).toContain("Hey there");
    expect(def.maxSteps).toBe(10);
    expect(def.tools).toEqual({});
  });

  test("preserves explicit values", () => {
    const greetTool = tool({
      description: "Greet",
      inputSchema: z.object({ name: z.string() }),
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

  function pipelineAgent() {
    const stt = assemblyAIStt({ model: "universal-3-5-pro" });
    const tts = cartesia({ voice: "v" });
    const llm = anthropic({ model: "claude-haiku-4-5" });
    return { stt, llm, tts, def: agent({ name: "t", systemPrompt: "p", stt, llm, tts }) };
  }

  test("preserves stt/llm/tts providers on the returned def", () => {
    const { stt, llm, tts, def } = pipelineAgent();
    expect(def.stt).toBe(stt);
    expect(def.llm).toBe(llm);
    expect(def.tts).toBe(tts);
  });

  test("stt/llm/tts flow through parseManifest to mode 'pipeline'", () => {
    const { stt, llm, tts, def } = pipelineAgent();
    const parsed = parseManifest(def);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toStrictEqual(stt);
    expect(parsed.llm).toStrictEqual(llm);
    expect(parsed.tts).toStrictEqual(tts);
  });

  test("agent without providers resolves to the default AssemblyAI pipeline", () => {
    const def = agent({ name: "t", systemPrompt: "p" });
    const parsed = parseManifest(def);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt?.kind).toBe("assemblyai");
    expect(parsed.llm?.kind).toBe("assemblyai");
    expect(parsed.tts?.kind).toBe("assemblyai");
  });

  test("agent with s2s descriptor resolves to mode 's2s'", () => {
    const def = agent({ name: "t", systemPrompt: "p", s2s: assemblyAIS2s() });
    const parsed = parseManifest(def);
    expect(parsed.mode).toBe("s2s");
    expect(parsed.stt).toBeUndefined();
    expect(parsed.llm).toBeUndefined();
    expect(parsed.tts).toBeUndefined();
  });

  test("a single declared stage keeps it; the rest fill from the default pipeline", () => {
    const llm = anthropic({ model: "claude-haiku-4-5" });
    const parsed = parseManifest(agent({ name: "t", llm }));
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.llm).toStrictEqual(llm);
    expect(parsed.stt).toEqual(assemblyAIPipeline().stt);
    expect(parsed.tts).toEqual(assemblyAIPipeline().tts);
  });

  test("`voice` desugars to the default pipeline's TTS descriptor", () => {
    const def = agent({ name: "t", voice: "michael" });
    expect("voice" in def).toBe(false);
    expect(def.tts).toEqual(assemblyAITts({ voice: "michael" }));
    // stt/llm stay undeclared on the def; parse fills them.
    expect(def.stt).toBeUndefined();
    expect(def.llm).toBeUndefined();
    const parsed = parseManifest(def);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.tts).toEqual(assemblyAITts({ voice: "michael" }));
  });

  test("`voice` combined with an explicit tts descriptor throws", () => {
    expect(() =>
      agent({ name: "t", voice: "michael", tts: cartesia({ voice: "v" }) } as never),
    ).toThrow(/`voice` picks the default pipeline's TTS voice/);
  });

  test("`voice` combined with s2s throws", () => {
    expect(() => agent({ name: "t", voice: "michael", s2s: assemblyAIS2s() } as never)).toThrow(
      /`voice` is pipeline-mode only/,
    );
  });
});
