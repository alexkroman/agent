/** The def a DEPLOYED agent runs: authored, plus `tools/` and `system-prompt.md`. */
import deployedDef from "virtual:aai/agent";
import { agent, assemblyAIPipeline, DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { expectDeployable } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

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
 * mode needs is filled) are `expectDeployable`'s, which fails naming the one
 * that went.
 */
describe("quickstart-agent template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // The template's point: with no provider fields declared, the default
    // all-AssemblyAI cascaded pipeline is injected at parse time (see
    // `defaultProviders`) — so an agent that declares nothing still runs.
    // `expectDeployable` asserts that per MODE, so it stays true after a swap:
    // declare `stt`/`llm`/`tts` and the rest still default; declare `s2s` and
    // there is no cascade to fill, which is the one thing that must never
    // happen by fallthrough.
    //
    // `not.toThrow()` because the helper's throw IS the finding: vitest quotes
    // the thrown message, which names the invariant that went.
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

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
    // (or a `voice:`, which desugars to a `tts` descriptor) is compared
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
    // `deployedDef` rather than `agentDef` above: the raw export has no tools
    // and the framework-default prompt, which is exactly what makes an
    // assertion against it unable to see either half go missing.
    expect(Object.keys(deployedDef.tools ?? {})).toEqual(["get_weather"]);
    // Not "some prompt" but NOT the framework's — `system-prompt.md` is the
    // one file an author edits first, and a prompt silently ignored produces
    // an agent that behaves plausibly and wrongly rather than one that
    // visibly cannot do something.
    expect(deployedDef.systemPrompt).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(deployedDef.systemPrompt).toContain("get_weather");
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
    // And what a prompt of your own resolves to is your text ALONE. That is
    // not the voice core being thrown away: the runtime emits it every
    // session and appends yours under a header saying yours wins where they
    // conflict. So write only your own rules — `DEFAULT_SYSTEM_PROMPT` is
    // exported to be READ (print it, diff it across releases), not pasted in.
    const own = agent({ name: "Quickstart Assistant", systemPrompt: "Only discuss the weather." });
    expect(expectDeployable(own).systemPrompt).toBe("Only discuss the weather.");
  });
});
