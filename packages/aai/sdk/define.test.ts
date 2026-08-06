// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "./agent-config.ts";
import { agent, tool } from "./define.ts";
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

  test("the default pipeline turns reasoning OFF", () => {
    // Time-to-first-token IS the quality on a voice line, and nothing in the
    // pipeline can cover the wait before the first token (holdPhrase needs a
    // turn that opened with a tool call; the dead-air cover measures tool
    // execution). Pinned as a test because the symptom of losing it is seconds
    // of silence rather than an error.
    const { llm } = assemblyAIPipeline();
    expect(llm.options.reasoningEffort).toBe("none");
    // The descriptor must carry a model that accepts the parameter. On the
    // current default the preset is the ONLY thing setting it — gpt-5.5 is not
    // in TOOLS_REQUIRE_NO_REASONING, so the factory contributes no effort of
    // its own and this assertion is what stands between the default pipeline
    // and per-turn thinking latency.
    expect(llm.options.model).toBe("gpt-5.5");

    // An agent with no providers at all gets the same treatment. Asserted
    // through toAgentConfig, not agent(): the default fill runs at the
    // mode-derivation sites (toAgentConfig, and the runtime's provider
    // resolution), so `agent()` itself leaves the stage unset.
    expect(toAgentConfig(agent({ name: "t" })).llm).toStrictEqual(llm);

    // Region must not drop it.
    expect(assemblyAIPipeline({ region: "eu" }).llm.options.reasoningEffort).toBe("none");
  });

  test("an explicit llm stage keeps its own reasoning setting", () => {
    // The override replaces the descriptor whole, which is what keeps
    // `reasoning_effort` off models that reject it.
    const claude = assemblyAILlm({ model: "claude-sonnet-4-6" });
    expect(agent({ name: "t", llm: claude }).llm).toBe(claude);
    expect(claude.options.reasoningEffort).toBeUndefined();
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

  test("stt/llm/tts flow through toAgentConfig to mode 'pipeline'", () => {
    const { stt, llm, tts, def } = pipelineAgent();
    const parsed = toAgentConfig(def);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt).toStrictEqual(stt);
    expect(parsed.llm).toStrictEqual(llm);
    expect(parsed.tts).toStrictEqual(tts);
  });

  test("agent without providers resolves to the default AssemblyAI pipeline", () => {
    const def = agent({ name: "t", systemPrompt: "p" });
    const parsed = toAgentConfig(def);
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.stt?.kind).toBe("assemblyai");
    expect(parsed.llm?.kind).toBe("assemblyai");
    expect(parsed.tts?.kind).toBe("assemblyai");
  });

  test("agent with s2s descriptor resolves to mode 's2s'", () => {
    const def = agent({ name: "t", systemPrompt: "p", s2s: assemblyAIS2s() });
    const parsed = toAgentConfig(def);
    expect(parsed.mode).toBe("s2s");
    expect(parsed.stt).toBeUndefined();
    expect(parsed.llm).toBeUndefined();
    expect(parsed.tts).toBeUndefined();
  });

  test("a single declared stage keeps it; the rest fill from the default pipeline", () => {
    const llm = anthropic({ model: "claude-haiku-4-5" });
    const parsed = toAgentConfig(agent({ name: "t", llm }));
    expect(parsed.mode).toBe("pipeline");
    expect(parsed.llm).toStrictEqual(llm);
    expect(parsed.stt).toEqual(assemblyAIPipeline().stt);
    expect(parsed.tts).toEqual(assemblyAIPipeline().tts);
  });

  test("`voice` desugars to the default pipeline's TTS descriptor", () => {
    const def = agent({ name: "t", voice: "michael" });
    expect("voice" in def).toBe(false);
    expect(def.tts).toEqual(assemblyAITts({ voice: "michael" }));
    // stt/llm stay undeclared on the def; toAgentConfig fills them.
    expect(def.stt).toBeUndefined();
    expect(def.llm).toBeUndefined();
    const parsed = toAgentConfig(def);
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
