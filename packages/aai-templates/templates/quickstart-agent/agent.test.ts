import agentDef from "virtual:aai/agent";
import { agent, assemblyAIPipeline, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { deployedAgent, expectDeployable } from "@alexkroman1/aai-runtime/testing";
import { describeAgent } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect, test } from "vitest";

/**
 * What a starter's spec may assert.
 *
 * Renaming the agent, giving it a voice, swapping a stage or switching the
 * whole thing to speech-to-speech are the first edits this template invites —
 * and `aai build` runs these tests before it bundles, so an assertion that
 * pins the template's own identity turns the first customization into a build
 * failure in a file the author never wrote. Every test here therefore asserts
 * a property that survives those edits, on the RESOLVED config rather than on
 * the def's empty fields — and the three every starter owes (the config passes
 * the conversion `aai build` runs, the platform can name it, every stage its
 * mode needs is filled) are `describeAgent`'s built-in "is deployable" case,
 * which fails naming the one that went.
 */
describeAgent(agentDef, () => {
  test("what gets filled in is exactly `assemblyAIPipeline()` — the default, spelled out", () => {
    const config = expectDeployable(agentDef);
    if (config.mode !== "pipeline") {
      // Switched the def to `s2s`? Then there is no cascade to fill — S2S
      // REPLACES the pipeline rather than joining it.
      expect(config.mode).toBe("s2s");
      return;
    }
    // Not "some AssemblyAI descriptor" but THE one: `defaultProviders` calls
    // this preset for every stage left unset, so the two are the same three
    // values. Knowing that is what makes the preset useful — spread it into
    // `agent()` when you want the stages visible in the config, or reach for
    // `assemblyAIPipeline({ region: "eu" })` to move STT and the LLM gateway
    // together. Each stage is read off the DEF first, so a stage you declare
    // (this template declares `tts`, for its voice) is compared
    // against your own value rather than the preset's.
    const preset = assemblyAIPipeline();
    for (const stage of ["stt", "llm", "tts"] as const) {
      expect(config[stage], stage).toEqual(agentDef[stage] ?? preset[stage]);
    }
  });

  test("the two DISCOVERED halves are really discovered", () => {
    // The template's central claim, and until it shipped these files there was
    // nothing here to make it. `virtual:aai/agent` is the lowering a DEPLOYED
    // agent gets — the authored def plus what `tools/` and `system-prompt.md`
    // declare — so this asserts the thing the quickstart tells a reader to
    // trust: the tool is registered by being a file, and the prompt is applied
    // by sitting beside `agent.ts`.
    //
    // `virtual:aai/agent` rather than `./agent.ts`: the raw export has no
    // tools and the framework-default prompt, which is exactly what makes an
    // assertion against it unable to see either half go missing.
    expect(Object.keys(agentDef.tools ?? {})).toEqual(["get_weather"]);
    // Not "some prompt" but NOT the framework's — `system-prompt.md` is the
    // one file an author edits first, and a prompt silently ignored produces
    // an agent that behaves plausibly and wrongly rather than one that
    // visibly cannot do something.
    expect(agentDef.systemPrompt).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(agentDef.systemPrompt).toContain("get_weather");
  });

  test("write no prompt and you already have one: the SDK's voice core", () => {
    // The other half of "declares nothing and still runs", and the one an
    // author meets first. Built here rather than read off `agentDef`, so
    // writing your own prompt — or dropping a `system-prompt.md` beside
    // `agent.ts`, which the BUILD folds in — does not redden a claim about
    // the SDK's default.
    expect(expectDeployable(agent({ name: "Quickstart Assistant" })).systemPrompt).toBe(
      DEFAULT_SYSTEM_PROMPT,
    );
    // And what a `system-prompt.md` of your own resolves to is your text
    // ALONE (`deployedAgent` is the build's lowering, handed the file's text).
    // That is not the voice core being thrown away: the runtime emits it every
    // session and appends yours under a header saying yours wins where they
    // conflict. So write only your own rules — `DEFAULT_SYSTEM_PROMPT` is
    // exported to be READ (print it, diff it across releases), not pasted in.
    const own = deployedAgent(agent({ name: "Quickstart Assistant" }), {
      systemPrompt: "Only discuss the weather.",
    });
    expect(expectDeployable(own).systemPrompt).toBe("Only discuss the weather.");
  });
});
