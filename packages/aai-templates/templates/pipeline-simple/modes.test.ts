/**
 * Which stages a MODE even has — the question `stages.test.ts` assumes.
 *
 * `agent()` takes one union, `AgentParams`, with one arm per mode, and the arm
 * is selected by which field you set. That is why `agent({ s2s, tts })` does not
 * compile: the arm carrying `s2s` types `tts` as a sentence explaining itself.
 * Each arm is exported, so a helper that BUILDS a def — a factory, a config
 * assembled across files — can name the shape it takes instead of widening to
 * the whole union and losing the refusals.
 */

import {
  type AgentDef,
  type AgentParams,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  assemblyAIS2s,
  type PipelineAgentParams,
  type PipelineVoiceTuning,
  requireEnv,
  type S2sAgentParams,
  type SharedAgentParams,
  type TextAgentParams,
} from "@alexkroman1/aai";
import { anthropicLlm } from "@alexkroman1/aai/llm";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";

/**
 * The half every arm has: who the agent is, and what it says.
 *
 * `SharedAgentParams` is `AgentParams` minus the provider fields and minus
 * everything one mode owns, so spreading it into each arm below is the union's
 * own structure written down — and a field that moves out of the shared half
 * reddens here rather than in three places that quietly disagree.
 *
 * `satisfies` rather than an annotation, and the reason is the text arm: the
 * shared half carries `sttPrompt` and `telephony`, which a text agent has no
 * audio path for, so its arm re-types both as the sentence saying so. An
 * ANNOTATED const would spread those two optional keys into every arm and stop
 * compiling on that one; `satisfies` checks the object and keeps its own type.
 */
const SHARED = {
  name: "Line",
  greeting: "Hi! I'm running in pipeline mode. What can I help with?",
  systemPrompt: "Answer in one or two sentences.",
} satisfies SharedAgentParams;

describe("three modes, three arms", () => {
  test("the field you set is what selects the mode", () => {
    const byMode: Record<string, AgentParams> = {
      // Pipeline is the DEFAULT arm and the one `agent.ts` is in: STT → LLM →
      // TTS, each stage swappable, every one you leave unset filled from the
      // all-AssemblyAI preset.
      pipeline: {
        ...SHARED,
        llm: anthropicLlm({ model: "claude-haiku-4-5" }),
      } satisfies PipelineAgentParams,
      // S2S replaces all three with one service-side loop.
      s2s: { ...SHARED, s2s: assemblyAIS2s() } satisfies S2sAgentParams,
      // Text has no audio path at all — no STT to bias, no voice, no telephony,
      // and its arm types every one of those fields as the sentence saying so.
      text: { ...SHARED, text: true } satisfies TextAgentParams,
    };

    for (const [mode, params] of Object.entries(byMode)) {
      expect(toAgentConfig(agent(params)).mode, mode).toBe(mode);
    }
  });

  test("`agent()` returns an `AgentDef` — the params with the conveniences lowered", () => {
    // The two types are not the same shape, and this is the difference worth
    // seeing: `AgentParams` is what an author WRITES (a model id string for
    // `llm`, `voice` as a bare voice name), `AgentDef` is what comes back, with
    // each of those already a provider descriptor. Everything downstream — the
    // config, the bundle, the runtime — reads the second.
    const def: AgentDef = agent({ ...SHARED, voice: "michael", llm: "claude-sonnet-4-6" });
    expect(def.tts?.kind).toBe("assemblyai");
    expect(def.tts?.options.voice).toBe("michael");
    expect(def.llm?.options.model).toBe("claude-sonnet-4-6");
  });
});

test("the preset takes OPTIONS — one setting across the three stages at once", () => {
  // That a bare `assemblyAIPipeline()` is exactly what an undeclared agent gets
  // filled with is `simple`'s claim, and it stays there. This is the half that
  // template only points at: the options bag, which is the reason to reach for
  // the preset rather than let the default fill happen. `region` applies to STT
  // and the LLM gateway together, so a residency choice is made once instead of
  // on two descriptors that can drift apart, and `voice` to TTS. (An EU agent
  // also has to name a model the EU gateway carries — Claude and most Gemini
  // ids — which is the half no shorthand can do for you.)
  const options: AssemblyAIPipelineOptions = { region: "eu", voice: "michael" };
  const pipeline = assemblyAIPipeline(options);
  expect(pipeline.stt.options.region).toBe("eu");
  expect(pipeline.llm.options.region).toBe("eu");
  expect(pipeline.tts.options.voice).toBe("michael");

  // And a stage declared AFTER the spread still wins — that is the whole point
  // of it being a plain object, and it is how this template's own `agent.ts`
  // would read if it wanted the other two stages visible in the config.
  const mine = anthropicLlm({ model: "claude-haiku-4-5" });
  expect(agent({ ...SHARED, ...pipeline, llm: mine }).llm).toBe(mine);
});

describe("voice-UX tuning is pipeline-only", () => {
  /**
   * The knobs that only exist because there IS a cascade: barge-in, dead air,
   * and what the agent says when a stage fails. `AgentDef` extends
   * `PipelineVoiceTuning`, so these sit on `agent()` beside the stages rather
   * than on a descriptor — none of them belongs to one vendor.
   */
  const TUNING: PipelineVoiceTuning = {
    minBargeInWords: 3,
    interruptionMinDurationMs: 200,
    deadAirCoverMs: 1200,
    errorPhrase: "Sorry — I lost that. Say it once more?",
    startFailurePhrase: "I'm having trouble hearing you right now.",
    resumeFalseInterruption: true,
    preemptiveGeneration: true,
  };

  test("every field survives into the config a deploy carries", () => {
    // Same claim `agent.test.ts` makes about a stage's `options`, one level up:
    // tuning that arrives dropped leaves a working agent with none of the voice
    // behaviour its author configured, and nothing on the line saying so.
    expect(toAgentConfig(agent({ ...SHARED, ...TUNING }))).toMatchObject(TUNING);
  });

  test("and an S2S agent is refused it rather than ignoring it", () => {
    // The S2S provider owns endpointing and barge-in service-side, so these
    // would be silently ignored there. The type says so first (each field is a
    // sentence on the `s2s` arm), which is why this reaches the runtime rule by
    // spreading — the half that also catches a raw `export default {...}`.
    const s2sAgent = agent({ ...SHARED, s2s: assemblyAIS2s() });
    expect(() => toAgentConfig({ ...s2sAgent, ...TUNING })).toThrow(/requires pipeline mode/);
  });
});

test("a stage you swap brings its own credential", () => {
  // The template's lesson, from the tool side. A descriptor never carries a
  // key — `apiKeyEnv` names a VARIABLE, and the host reads it at session start
  // — so a tool body calling the same vendor directly reads the same way, and
  // `requireEnv` is that read: it fails by NAME instead of surfacing as a
  // `TypeError` on the first property access, which the tool executor would
  // hand to the model as an apology no log line explains.
  const ctx = { env: { ANTHROPIC_API_KEY: "from-the-secret-store" } };
  expect(requireEnv(ctx, "ANTHROPIC_API_KEY")).toBe("from-the-secret-store");
  expect(() => requireEnv(ctx, "OPENAI_API_KEY")).toThrow(/OPENAI_API_KEY/);
});
