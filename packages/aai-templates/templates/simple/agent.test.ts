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
describe("simple template", () => {
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
});
