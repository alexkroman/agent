/**
 * The def a DEPLOYED agent runs: authored, plus the `system-prompt.md` beside
 * it.
 *
 * This template declares no `tools/` at all — every calculation is the
 * `run_code` builtin's — so the prompt is the only thing discovery adds here,
 * and it is what half the tests below are about. Importing `./agent.ts`
 * directly would measure a tutor whose prompt is the framework default, i.e.
 * an agent that was never told to compute in code.
 */
import agentDef from "virtual:aai/agent";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";

/**
 * What a starter's spec may assert.
 *
 * `aai build` runs these tests before it bundles, so an assertion pinning this
 * tutor's own identity — its literal name, the wording of its greeting, the
 * model id it happens to run today — turns the first customization into a build
 * failure in a file the author never wrote. Every test here therefore asserts a
 * property that survives a rename, a voice, a reworded prompt and a model swap,
 * on the RESOLVED config rather than on the def's empty fields.
 *
 * `run_code` is the one thing named literally, and deliberately: taking it away
 * is not a customization of Math Buddy but a deletion of its subject — the
 * prompt is nothing but recipes for it — and the tutor left behind does
 * arithmetic from memory, which reads exactly like a correct answer until it is
 * wrong.
 *
 * What is NOT here is anything about the code the tutor writes or the answer it
 * comes back with: that needs a model and a sandbox, so it belongs to
 * `agent.eval.test.ts`, which supplies both. This tier's question is the one
 * that comes first — was the tutor handed anything to run at all.
 */
describe("math-buddy template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run — and the only thing that
    // says this template's declared LLM descriptor is well formed before a
    // live session tries to open one from it.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent the platform can name", () => {
    // Not the literal: what has to hold is that there IS a name and that the
    // conversion carries it through — `AgentName` refuses a blank one, and the
    // studio lists a deployed agent by exactly this string.
    expect(agentDef.name).toBeTruthy();
    expect(toAgentConfig(agentDef).name).toBe(agentDef.name);
  });

  test("run_code is declared, and the prompt the deploy carries asks for it", () => {
    const config = toAgentConfig(agentDef);
    // Two halves, each of which fails silently and produces a plausible tutor.
    // Without the declaration the model has nothing to run, so it computes in
    // its head and says the answer with the same confidence either way. Without
    // the prompt reaching the CONFIG — the "I edited system-prompt.md and
    // nothing changed" failure `withSystemPrompt` exists to catch, since the
    // file is discovered by the build rather than imported by `agent.ts` — the
    // recipes are gone and what deploys is a general assistant that happens to
    // have a sandbox attached. The framework default says nothing about
    // `run_code`, which is what makes the second assertion a real check on
    // discovery rather than a restatement of the first.
    expect(config.builtinTools).toContain("run_code");
    expect(config.systemPrompt).toContain("run_code");
  });

  test("whichever model this tutor runs on, the conversion carries its tuning", () => {
    const config = toAgentConfig(agentDef);
    if (config.mode !== "pipeline") {
      // Switched the def to `s2s`? Then one model listens and talks, and there
      // is no separate LLM stage left for anything to be carried on.
      expect(config.mode).toBe("s2s");
      expect(config.llm).toBeUndefined();
      return;
    }
    if (agentDef.llm === undefined) {
      // Dropped the declaration to take the default cascade: it still resolves
      // to a NAMED model, because the gateway refuses an unknown id with a 400
      // at the first session — "no model" is not a state a deploy may reach.
      expect(config.llm?.options.model).toBeTruthy();
      return;
    }
    // A model choice is the only reason this tutor declares a stage at all —
    // a quick, cheap one, since `run_code` does the arithmetic and what is left
    // is turn-taking speed. So the descriptor is checked whole rather than by
    // `kind`: one that arrived with its options dropped would deploy the
    // gateway's default model instead, quietly slower, with nothing on the line
    // saying so. Read off the def rather than pinned, because swapping the id
    // is the first tuning an author of this template tries.
    expect(config.llm?.kind).toBe(agentDef.llm.kind);
    expect(config.llm?.options).toEqual(agentDef.llm.options);
    expect(config.llm?.options.model).toBeTruthy();
  });

  test("every stage its mode needs is filled, declared or defaulted", () => {
    // This template's other half: it declares the LLM and nothing else, so STT
    // and TTS are injected at parse time (see `defaultProviders`) and the tutor
    // can still hear and speak. Asserted per MODE so it survives a swap —
    // declare `stt`/`tts` and the rest still default; declare `s2s` and there
    // is no cascade to fill, which is the one thing that must never happen by
    // fallthrough.
    const config = toAgentConfig(agentDef);
    if (config.mode === "s2s") {
      expect(config.s2s?.kind).toBeTruthy();
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
      return;
    }
    expect(config.mode).toBe("pipeline");
    for (const stage of ["stt", "llm", "tts"] as const) {
      expect(config[stage]?.kind, stage).toBe(agentDef[stage]?.kind ?? "assemblyai");
    }
  });

  test("the caller is told what to ask, and the greeting survives the conversion", () => {
    // A voice agent has no buttons, so the opener is the only place a caller
    // learns that this one wants arithmetic, conversions and dice rather than
    // conversation. It rides to the browser in `/client-config` beside `name`,
    // so what has to hold is that there is one and the conversion carries it:
    // a greeting lost at that boundary is replaced by the framework's generic
    // opener, which invites the caller to ask for anything at all.
    expect(agentDef.greeting).toBeTruthy();
    expect(toAgentConfig(agentDef).greeting).toBe(agentDef.greeting);
  });
});
