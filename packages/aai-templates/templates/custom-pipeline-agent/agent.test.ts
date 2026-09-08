import { expectDeployable } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("custom-pipeline-agent template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // The three invariants every starter owes, thrown by name — the same
    // conversion `aai build`/`aai deploy` run, so an invalid provider
    // combination or tuning fails here rather than at the first live session.
    // The name is deliberately NOT the literal: `aai init <project>` scaffolds
    // this file verbatim, so a pinned name would be a test about the TEMPLATE
    // inside somebody else's project — and renaming the agent is the first
    // thing they will do. `not.toThrow()` because the helper's throw IS the
    // finding: vitest quotes the message, which names the invariant that went.
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

  test("declares at least one stage itself, which is what makes it a pipeline", () => {
    // WHICH stage is deliberately not asserted: `agent.ts` invites you to move
    // the declaration ("Declare only the stage you want elsewhere"), so naming
    // one here would redden on the edit the comment above it asks for.
    const declared = (["stt", "llm", "tts"] as const).filter(
      (stage) => agentDef[stage] !== undefined,
    );
    expect(declared.length).toBeGreaterThan(0);
  });

  test("a stage you declare survives, and every stage you leave unset defaults to AssemblyAI", () => {
    // The template's whole subject, stated so it survives a swap: the config a
    // deploy carries agrees with the def wherever the def has an opinion, and
    // fills the AssemblyAI default wherever it does not. `expectDeployable`
    // already checks the first half (a declared stage survives as declared);
    // WHICH default fills the rest is this template's claim, so it is here.
    const config = expectDeployable(agentDef);
    if (config.mode !== "pipeline") {
      // Switched the def to `s2s`? Then there is no cascade to fill — S2S
      // REPLACES the pipeline rather than joining it, which `expectDeployable`
      // asserted and `stages.test.ts` is the worked example for.
      expect(config.mode).toBe("s2s");
      return;
    }
    for (const stage of ["stt", "llm", "tts"] as const) {
      expect(config[stage]?.kind, stage).toBe(agentDef[stage]?.kind ?? "assemblyai");
    }
  });

  test("a declared stage's TUNING survives too, not just its provider", () => {
    // The half `kind` cannot see, and the one a swap loses quietly: a
    // descriptor that arrives with its `options` dropped still reports the
    // right provider while running the gateway's default model — a different,
    // usually slower agent, with nothing on the line saying so. Read off the
    // def rather than pinned, because changing the model id is the first
    // tuning an author of this template tries. (This claim came from
    // `math-buddy`, which declared an LLM for the same reason and was removed
    // as a near-duplicate of `code-interpreter-agent`; the stage swap lives here.)
    const config = expectDeployable(agentDef);
    const declared = (["stt", "llm", "tts"] as const).filter(
      (stage) => agentDef[stage] !== undefined,
    );
    // The loop below is a sweep over a FILTER, so it asserts nothing at all on
    // a def that declares no stage — the state the test above forbids, said
    // again here because a vacuous pass looks exactly like a passing one.
    expect(declared.length).toBeGreaterThan(0);
    for (const stage of declared) {
      expect(config[stage]?.options, stage).toEqual(agentDef[stage]?.options);
    }
  });
});

/*
 * The other stage swaps live BESIDE this file rather than in it.
 *
 * `stages.test.ts` is the provider catalog — every STT, LLM, TTS and S2S
 * factory, the option type each takes, and the published defaults — and
 * `modes.test.ts` is which stages a mode even has. They are specs and not
 * `agent.ts` for the reason `agent.ts` declares one stage: a deployed agent
 * needs a key per vendor it names, and the all-AssemblyAI default is what makes
 * this starter run the moment it is deployed.
 */
