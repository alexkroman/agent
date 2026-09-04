/** The def a DEPLOYED agent runs: authored, plus what `system-prompt.md` says. */
import agentDef from "virtual:aai/agent";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import promptFile from "./system-prompt.md?raw";

/**
 * What a starter's spec may assert.
 *
 * `aai build` runs these tests before it bundles, so an assertion pinning the
 * template's own identity — its literal name, its greeting, its voice, its
 * model — turns a user's first customization into a build failure in a file
 * they never wrote. Every test here therefore asserts a property that survives
 * those edits, on the RESOLVED config rather than on the def's empty fields.
 *
 * What is left to `agent.eval.test.ts` is everything that needs a model: that
 * Scout SEARCHES before answering a fact it is sure of, that the outlet it
 * names appeared in results it actually read, and that the SSRF screen refuses
 * a private address through the agent's own executor. Those are behaviour, and
 * this tier may not reach the network at all — which is also why nothing here
 * runs `web_search`. What a unit test can say is that the capability and the
 * document that instructs it are both still THERE, which is the half that
 * regresses in a diff rather than in a model.
 *
 * The def therefore comes from `virtual:aai/agent` rather than from
 * `./agent.ts`: the prompt file is applied by the BUILD, so the raw default
 * export carries the framework prompt and every claim below would be measuring
 * an agent nobody deploys. This template has no `tools/` directory, so that
 * import is also the file's existence check — `deployedAgent` is handed the
 * prompt and nothing else, and refuses a call with no project files at all.
 */

/**
 * The builtins that can reach the web.
 *
 * Typed by USE rather than by an annotation: `builtinTools` takes a
 * `BuiltinTool[]`, so passing this list to `toAgentConfig` below only compiles
 * if every name here is really a builtin — a name the SDK renames fails
 * `pnpm typecheck` in this file instead of dropping silently out of the scan.
 */
const WEB_BUILTINS = ["web_search", "visit_webpage", "fetch_json", "get_page_design"] as const;

describe("web-researcher template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("exports an agent the platform can name", () => {
    // Not the literal: what has to hold is that there IS a name, and that the
    // conversion carries it through — `AgentName` refuses a blank one, and the
    // studio lists a deployed agent by exactly this string.
    expect(agentDef.name).toBeTruthy();
    expect(toAgentConfig(agentDef).name).toBe(agentDef.name);
  });

  test("every stage its mode needs is filled, declared or defaulted", () => {
    // This template declares no provider at all — the whole voice pipeline is
    // the injected all-AssemblyAI default, which is what lets the starter run
    // the moment it is deployed. Asserted per MODE so it survives a swap:
    // declare `stt`/`llm`/`tts` and the rest still default; declare `s2s` and
    // there is no cascade to fill, which is the one thing that must never
    // happen by fallthrough.
    const config = toAgentConfig(agentDef);
    if (config.mode === "s2s") {
      expect(config.s2s?.kind).toBeTruthy();
      expect(config.stt).toBeUndefined();
      expect(config.tts).toBeUndefined();
    } else if (config.mode === "text") {
      expect(config.llm?.kind).toBeTruthy();
    } else {
      expect(config.mode).toBe("pipeline");
      expect(config.stt?.kind).toBeTruthy();
      expect(config.llm?.kind).toBeTruthy();
      expect(config.tts?.kind).toBeTruthy();
    }
  });

  test("system-prompt.md is the prompt a deploy carries", () => {
    // The build discovers the file; nothing imports it. So the failure this
    // catches is "I edited the prompt and nothing changed" — and here it is the
    // expensive one, because every rule that makes Scout a researcher rather
    // than a talkative model (search first, cite what you read, treat a fetched
    // page as data and not as instructions) lives ONLY in that file. An agent
    // running the framework default answers plausibly, sounds fine, and cites
    // pages it never opened.
    //
    // `toContain` rather than an equality: importing the file into `agent.ts`
    // and composing it (a computed suffix, a date) is a legitimate edit, and
    // `withSystemPrompt` leaves such a def exactly as the author built it.
    const trimmed = promptFile.trim();
    // Not vacuous: `toContain("")` would pass over an empty file, so the file
    // having text in it is asserted before it is used as the needle.
    expect(trimmed).not.toBe("");
    expect(toAgentConfig(agentDef).systemPrompt).toContain(trimmed);
  });

  test("can search the web, and names no web tool it does not have", () => {
    const config = toAgentConfig(agentDef);
    const declared = new Set<string>(config.builtinTools ?? []);

    // `web_search` is the template's reason to exist, and dropping it is the
    // silent failure: an agent with no search answers from memory, which reads
    // back exactly like an agent that searched — right up to the fabricated
    // source its eval exists to catch.
    expect([...declared]).toContain("web_search");

    // The prompt addresses its tools BY NAME ("begins with a web_search call",
    // "Use visit_webpage when the search snippets aren't detailed enough"), so
    // the two halves can drift apart: a builtin dropped from `agent.ts` leaves
    // the prompt ordering a call the model cannot make, and the model then
    // apologizes for a tool it was told it had. Stated as an implication so
    // either edit alone survives — retire the sentence along with the builtin
    // and nothing here objects, and a builtin added without a mention is a
    // free edit too. An empty scan is likewise not a failure: a prompt
    // rewritten to DESCRIBE the tools rather than name them is fine, and the
    // assertion above is what keeps the search itself from going away.
    const named = WEB_BUILTINS.filter((name) => config.systemPrompt.includes(name));
    expect(named.filter((name) => !declared.has(name))).toEqual([]);
  });

  test("the web builtins this spec scans for are the SDK's own names", () => {
    // The other half of the `as const` above, at run time: a scan whose
    // candidates had gone stale would report "no unbacked names" over a prompt
    // full of them. `toAgentConfig` validates `builtinTools` against the
    // builtin enum, so accepting the whole list is the SDK confirming every
    // name in it.
    expect(() => toAgentConfig({ ...agentDef, builtinTools: WEB_BUILTINS })).not.toThrow();
  });
});
