// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { toAgentConfig } from "./agent-config.ts";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_MIN_TURN_SILENCE_MS } from "./constants.ts";
import { agent, tool, workflowApp } from "./define.ts";
import { assemblyAIPipeline } from "./providers/assemblyai-pipeline.ts";
import { anthropicLlm } from "./providers/llm/anthropic.ts";
import { assemblyAILlm } from "./providers/llm/assemblyai.ts";
import { assemblyAIS2s } from "./providers/s2s/assemblyai.ts";
import { assemblyAIStt, resolveAssemblyAISttSettings } from "./providers/stt/assemblyai.ts";
import { assemblyAITts } from "./providers/tts/assemblyai.ts";
import { cartesiaTts } from "./providers/tts/cartesia.ts";
import { createToolContext } from "./testing.ts";
import { type AgentDef, DEFAULT_SYSTEM_PROMPT } from "./types.ts";
import { workflow } from "./workflow.ts";

describe("tool()", () => {
  test("returns the definition unchanged", () => {
    const def = tool({
      description: "Greet someone",
      inputSchema: z.object({ name: z.string() }),
      execute: ({ name }) => `Hello, ${name}!`,
    });
    expect(def.description).toBe("Greet someone");
    // The published builder (`@alexkroman1/aai/testing`) rather than an empty
    // object laundered past the checker: it is what an agent author's own spec
    // uses, and the cast it replaces stopped reporting the moment `ToolContext`
    // gained a field the body reads. (Named obliquely on purpose — the
    // escape-hatch ratchet is a substring scan with no notion of comment versus
    // code, the same trap the file's note below records.)
    expect(def.execute({ name: "Alice" }, createToolContext())).toBe("Hello, Alice!");
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

/**
 * `agent()` reached with a value TypeScript never checked — which is the only
 * way its runtime guards can fire, and therefore the only honest way to drive
 * one. Neither bundler type-checks user code, so this is a real caller shape
 * rather than a test-only fiction.
 *
 * One narrowing in one place, on the repo's typed-seam rule. The alternative is
 * a compiler-suppression comment at each assertion, and that pattern's
 * escape-hatch baseline stands at zero repo-wide — which is worth keeping. (The
 * baseline is a substring scan with no notion of comment versus code, so naming
 * the pattern here would itself score as one. Same trap the ratchet documents
 * for markdown, arriving by a third route.)
 */
const agentUnchecked = agent as (def: object) => AgentDef;

describe("agent()", () => {
  // One seam for every "the type rejects this, does the RUNTIME reject it too"
  // case below, rather than a laundering cast per assertion. Each of those
  // configs is a compile error an author sees as a misuse type in tsc's own
  // message; what these tests cover is the throw behind it, which is what a
  // plain-JS caller — or a config that arrived through a widened type — hits
  // instead. Narrowing once means adding a case costs no new suppression, and
  // the seam names why the one it holds is unavoidable: the parameter types are
  // what make the call illegal, so there is nothing legal to pass.
  const agentMisuse = (config: Record<string, unknown>) => agent(config as never);

  test("`system` is not a field — it was an alias of `systemPrompt` and is gone", () => {
    // One concept, one name. The alias existed to match the Vercel AI SDK's
    // spelling and made `agent({ system, systemPrompt })` representable, which
    // then needed a runtime throw to forbid. It is now a stray field, so
    // `assertNoStrayFields` reports it and points at the name that exists.
    expect(() => agentMisuse({ name: "t", system: "You are terse." })).toThrow(
      /`system` \(renamed to `systemPrompt`\)/,
    );
  });

  test("a key that is present-and-undefined does not clobber a default", () => {
    // This repo compiles with `exactOptionalPropertyTypes`, so the literal
    // `agent({ greeting: undefined })` is a compile error HERE. A user's agent
    // project does not — `scaffold/tsconfig.json` sets `strict` and not that
    // flag — so `agent({ greeting: process.env.GREETING })` type-checks there
    // and reaches this function with own `undefined` keys. Assigning them one
    // at a time is how the spec models the caller the fix is for; the keys are
    // exactly the three `agent()` defaults.
    const opts: { greeting?: string; maxSteps?: number; systemPrompt?: string } = {};
    const own = opts as Record<string, unknown>;
    for (const key of ["greeting", "maxSteps", "systemPrompt"]) own[key] = undefined;
    expect(Object.keys(opts)).toHaveLength(3);

    const def = agent({ name: "t", ...opts });
    expect(def.greeting).toBe(DEFAULT_GREETING);
    expect(def.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(def.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
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
    // Time-to-first-token IS the quality on a voice line. The dead-air cover
    // does reach the pre-first-token window, but cover is not a substitute for
    // a low TTFT — it only keeps the line from sounding hung up while one
    // elapses. Pinned as a test because the symptom of losing it is seconds of
    // silence rather than an error.
    const { llm } = assemblyAIPipeline();
    expect(llm.options.reasoningEffort).toBe("none");
    // The descriptor must carry a model that accepts the parameter. Pinned
    // alongside the effort because the two are coupled: the current default
    // (`qwen3-next-80b-a3b`) is OUTSIDE TOOLS_REQUIRE_NO_REASONING, so the
    // factory fills in nothing and the preset's explicit `"none"` is the only
    // thing standing between the default pipeline and per-turn thinking
    // latency (measured 1786ms p50 time-to-first-token on gpt-5.5's
    // server-side default against 999ms with reasoning off). Under a
    // `gpt-5.6` id the factory would fill the same value and the argument
    // would merely agree with it — an id property, not a pipeline one. This
    // pair is what makes a change to either fail loudly.
    expect(llm.options.model).toBe("qwen3-next-80b-a3b");

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
    expect(def.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(def.tools).toEqual({});
  });

  test("preserves explicit values", () => {
    const def = agent({
      name: "Custom",
      systemPrompt: "Be nice.",
      greeting: "Hello!",
      maxSteps: 10,
      builtinTools: ["web_search"],
    });
    expect(def.systemPrompt).toBe("Be nice.");
    expect(def.greeting).toBe("Hello!");
    expect(def.maxSteps).toBe(10);
    expect(def.builtinTools).toEqual(["web_search"]);
  });

  test("refuses a tools map, naming the file to create instead", () => {
    const greetTool = tool({
      description: "Greet",
      inputSchema: z.object({ name: z.string() }),
      execute: ({ name }) => `Hi ${name}`,
    });
    // The TYPE rejects this too (`InlineToolsMisuse`, pinned in
    // `define.test-d.ts`), and the type alone would leave the rule
    // conventional: neither bundler type-checks user code, so a map that
    // reached here would work and "a tool is only ever a file" would be true of
    // the templates and of nothing else. Hence the throw — and a throw rather
    // than a silent drop, because the failure this whole mechanism replaces was
    // a tool that never reached the model, in silence.
    //
    // Called through `agentUnchecked` for the same reason the guard exists: what
    // gets here is a value TypeScript did not check.
    expect(() => agentUnchecked({ name: "Custom", tools: { greet: greetTool } })).toThrow(
      /a tool IS a file/,
    );
  });

  function pipelineAgent() {
    const stt = assemblyAIStt({ model: "universal-3-5-pro" });
    const tts = cartesiaTts({ voice: "v" });
    const llm = anthropicLlm({ model: "claude-haiku-4-5" });
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
    const llm = anthropicLlm({ model: "claude-haiku-4-5" });
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
      agentMisuse({ name: "t", voice: "michael", tts: cartesiaTts({ voice: "v" }) }),
    ).toThrow(/`voice` picks the default pipeline's TTS voice/);
  });

  test("`voice` combined with s2s throws", () => {
    expect(() => agentMisuse({ name: "t", voice: "michael", s2s: assemblyAIS2s() })).toThrow(
      /`voice` is pipeline-mode only/,
    );
  });

  test("endpointing shorthand desugars to the default pipeline's STT descriptor", () => {
    // The point of the shorthand: one number, no descriptor, and the stage is
    // still the default AssemblyAI one with every other setting intact.
    const def = agent({ name: "t", maxTurnSilenceMs: 4500 });
    expect("maxTurnSilenceMs" in def).toBe(false);
    expect(def.stt).toEqual(assemblyAIStt({ maxTurnSilenceMs: 4500 }));
    expect(toAgentConfig(def).mode).toBe("pipeline");
    const settings = resolveAssemblyAISttSettings({ maxTurnSilenceMs: 4500 });
    expect(settings.maxTurnSilenceMs).toBe(4500);
    // The knob it is NOT paired with keeps its measured default.
    expect(settings.minTurnSilenceMs).toBe(DEFAULT_MIN_TURN_SILENCE_MS);
  });

  test("both endpointing knobs desugar together", () => {
    const def = agent({ name: "t", minTurnSilenceMs: 1800, maxTurnSilenceMs: 4500 });
    expect(def.stt).toEqual(assemblyAIStt({ minTurnSilenceMs: 1800, maxTurnSilenceMs: 4500 }));
  });

  test("endpointing shorthand beside an explicit stt descriptor throws", () => {
    expect(() =>
      agentMisuse({ name: "t", maxTurnSilenceMs: 4500, stt: assemblyAIStt({ region: "eu" }) }),
    ).toThrow(/an explicit `stt` descriptor owns its own end-of-turn window/);
  });

  test("endpointing shorthand combined with s2s throws", () => {
    expect(() => agentMisuse({ name: "t", maxTurnSilenceMs: 4500, s2s: assemblyAIS2s() })).toThrow(
      /S2S runs STT service-side/,
    );
  });

  test("endpointing shorthand combined with text throws", () => {
    expect(() => agentMisuse({ name: "t", maxTurnSilenceMs: 4500, text: true })).toThrow(
      /a text agent has none/,
    );
  });

  test("assemblyAIPipeline carries the endpointing options onto its STT stage", () => {
    // The preset is the escape hatch the shorthand cannot serve: a config that
    // already spreads it (for `region`) sets the window here instead.
    const { stt } = assemblyAIPipeline({ region: "eu", maxTurnSilenceMs: 4500 });
    const settings = resolveAssemblyAISttSettings(stt.options);
    expect(settings.maxTurnSilenceMs).toBe(4500);
    expect(settings.region).toBe("eu");
  });
});

describe("workflowApp()", () => {
  const digest = workflow({
    description: "Digest a link",
    input: z.object({ url: z.string() }),
    run: async ({ url }: { url: string }) => ({ url }),
  });

  test("declares the front door, so the field is the call rather than a thing to remember", () => {
    const def = workflowApp({ name: "Link Digest", workflows: { digest } });
    expect(def.page).toBe("static");
    expect(def.workflows).toEqual({ digest });
  });

  test("is `agent()` underneath — same definition, so nothing downstream sees a second shape", () => {
    const viaHelper = workflowApp({ name: "Link Digest", workflows: { digest } });
    const viaAgent = agent({ name: "Link Digest", workflows: { digest }, page: "static" });
    expect(viaHelper).toEqual(viaAgent);
  });

  test("the agent defaults still fill, because AgentDef requires them", () => {
    // Nothing READS them on a static agent — no session opens and no model
    // runs — but `AgentDef` types all three as required, so the alternative to
    // filling them is a definition that lies about its own shape.
    const def = workflowApp({ name: "Link Digest", workflows: { digest } });
    expect(def.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(def.greeting).toBe(DEFAULT_GREETING);
    expect(def.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(def.tools).toEqual({});
  });

  test("a greeting passes through, because `GET /client-config` serves it", () => {
    // The one client-config field a workflow app can still put to work: `page()`
    // does not fetch it the way `client()` does, so a page that wants it calls
    // `fetchClientConfig()`.
    const def = workflowApp({
      name: "Link Digest",
      greeting: "Paste a link.",
      workflows: { digest },
    });
    expect(def.greeting).toBe("Paste a link.");
  });
});
