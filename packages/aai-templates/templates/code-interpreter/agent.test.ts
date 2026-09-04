/** The def a DEPLOYED agent runs: authored, plus the `system-prompt.md` beside it. */
import agentDef from "virtual:aai/agent";
import { AgentConfigSchema, toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";

/**
 * What this starter's spec may assert.
 *
 * Renaming Coda, giving her a voice, swapping a stage or switching the whole
 * thing to speech-to-speech are the first edits this template invites — and
 * `aai build` runs these tests before it bundles, so an assertion that pins the
 * template's own identity turns the first customization into a build failure in
 * a file the author never wrote. Every test here asserts a property that
 * survives those edits, on the RESOLVED config rather than on the def's empty
 * fields.
 *
 * What it may NOT assert is whether `run_code` actually RUNS: the builtin is
 * sandbox-only, so off-platform it declines rather than evaluating
 * model-written JavaScript in the host process. That is right, and it leaves
 * "Coda reached for code, and the code came back with 107823" to
 * `agent.eval.test.ts`, which supplies an executor of its own. What is reachable
 * in memory is the pairing the template is built on — the builtin it asks for
 * and the prompt that commands it — and that is what the last two tests are.
 */
describe("code-interpreter template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent the platform can name", () => {
    // Not the literal: what has to hold is that there IS a name and that the
    // conversion carries it through — `AgentName` refuses a blank one, and the
    // studio lists a deployed agent by exactly this string.
    expect(agentDef.name).toBeTruthy();
    expect(toAgentConfig(agentDef).name).toBe(agentDef.name);
  });

  test("whatever mode it ends up in, there is a model to call the tool with", () => {
    // A builtin is something a MODEL reaches for, so this template is only
    // itself while some stage can issue a tool call. Asserted per MODE so it
    // survives the swaps above: declare `stt`/`llm`/`tts` and the rest still
    // default to the all-AssemblyAI cascade (which is why the def declares no
    // provider at all and still runs); declare `s2s` and there is no cascade to
    // fill, which is the one thing that must never happen by fallthrough.
    const config = toAgentConfig(agentDef);
    if (config.mode === "s2s") {
      expect(config.s2s?.kind).toBeTruthy();
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
      return;
    }
    expect(config.llm?.kind).toBeTruthy();
    if (config.mode === "pipeline") {
      expect(config.stt?.kind).toBeTruthy();
      expect(config.tts?.kind).toBeTruthy();
    }
  });

  test("run_code survives into the config a deploy carries", () => {
    // The template's whole capability, asserted on the CONFIG rather than the
    // def because that is what a deploy ships. `DEFAULT_BUILTIN_TOOLS` is
    // EMPTY — a builtin is something an agent asks for, never something it has
    // to notice and switch off — so a dropped `builtinTools` is not a degraded
    // Coda, it is an agent whose prompt forbids mental arithmetic and leaves it
    // nothing else to do. Adding builtins beside it is fine; losing this one is
    // the regression.
    expect(toAgentConfig(agentDef).builtinTools ?? []).toContain("run_code");
  });

  test("every builtin the prompt commands by name is one the agent declares", () => {
    // The pairing that makes this template work, and the failure it catches is
    // silent in both directions: a prompt commanding `fetch_json` at an agent
    // that never declared it produces a model apologizing for a tool it cannot
    // see, and a builtin renamed in `agent.ts` alone leaves the CRITICAL RULES
    // addressed to nothing. Neither shows up in a diff of either file.
    const config = toAgentConfig(agentDef);
    const declared = config.builtinTools ?? [];

    // Which snake_case tokens in the prose are TOOL NAMES is a question for the
    // SDK's own schema, not for a list restated here: a catalog copied into a
    // spec goes stale, and matching every underscored word would redden on a
    // prompt that names a variable in one of its examples.
    const isBuiltin = (name: string) =>
      AgentConfigSchema.safeParse({ ...config, builtinTools: [name] }).success;
    const commanded = [
      ...new Set(config.systemPrompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []),
    ].filter(isBuiltin);

    // Non-vacuity, and it earns its keep twice: a prompt naming no builtin at
    // all would make the loop below assert nothing, and it is also the state a
    // template gets into when `system-prompt.md` is not applied — the framework
    // default names no builtin, so an agent running on it lands here rather
    // than passing quietly with the CRITICAL RULES nowhere in its context.
    expect(commanded.length).toBeGreaterThan(0);
    for (const name of commanded) {
      expect(declared, `the prompt commands ${name}`).toContain(name);
    }
    // The converse is deliberately NOT asserted: declaring a builtin the prompt
    // never mentions is an ordinary edit, and the model is told about it by its
    // own tool schema.
  });
});
