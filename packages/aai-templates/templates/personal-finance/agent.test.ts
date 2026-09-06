/** The def a DEPLOYED agent runs: authored, plus what `system-prompt.md` says. */
import agentDef from "virtual:aai/agent";
import { expectDeployable, expectPromptBuiltinsDeclared } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";

/**
 * What a starter's spec may assert.
 *
 * `aai init` scaffolds this template verbatim, and `aai build` runs these tests
 * before it bundles — so an assertion pinning Penny's own identity (her literal
 * name, her voice, her model, the wording of a house rule) turns a user's first
 * customization into a build failure in a file they never wrote. Every test
 * here therefore asserts a property that survives those edits, on the RESOLVED
 * config rather than on the def's empty fields; the three every starter owes
 * are `expectDeployable`'s.
 *
 * What is deliberately NOT here: whether Penny actually reaches for `run_code`
 * instead of dividing in her head, whether she looks a rate up rather than
 * quoting a remembered one, and whether she keeps the not-financial-advice
 * caveat. Those are claims about a live model and belong to
 * `agent.eval.test.ts`, which drives them against one. This tier asserts the
 * WIRING those runs depend on — a template whose builtins never reached the
 * config fails an eval as a behaviour problem, in a report nobody reads as
 * "the tool was not there".
 */
describe("personal-finance template", () => {
  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // The same conversion `aai build`/`aai deploy` run. It is also what checks
    // the two builtin NAMES against the SDK's own enum, so a typo in
    // `builtinTools` fails here rather than shipping an agent whose prompt
    // commands a tool the platform never resolved. This template declares no
    // provider at all — it is a prompt and two builtins — so the default
    // all-AssemblyAI cascade is what makes it run the moment it is deployed;
    // `expectDeployable` asserts that per MODE, so it survives a swap.
    // `not.toThrow()` because the helper's throw IS the finding: vitest quotes
    // the message, which names the invariant that went.
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

  test("both builtins survive into the config a deploy carries", () => {
    const builtins = expectDeployable(agentDef).builtinTools ?? [];

    // `run_code` is the arithmetic rule's only mechanism. The prompt forbids
    // Penny working ANY figure out in her head — a tip, a split, a payment, a
    // projection — so without the builtin the rule has nothing to point at and
    // degrades into a model inventing numbers the caller then spends money on.
    expect(builtins).toContain("run_code");

    // `fetch_json` is the only route to a number that MOVES. A rate or a coin
    // price the model remembers is months stale and carries no source, and it
    // arrives in exactly the confident tone a fetched one would — which is why
    // a finance starter that cannot make a request is worse than one that
    // declines to answer.
    expect(builtins).toContain("fetch_json");

    // Asserted on the CONFIG rather than the def because that is what a deploy
    // ships, and because `DEFAULT_BUILTIN_TOOLS` is empty: a builtin is
    // something an agent asks for, never something it has to notice and switch
    // off. So a dropped entry is not a quieter Penny, it is the same Penny with
    // no way to be right. Adding builtins beside these two is an ordinary edit;
    // losing one is the regression.
  });

  test("every builtin the prompt tells Penny to use is one she declares", () => {
    // The pairing this template is made of: the prose holds the endpoints and
    // the formulas, each list headed by the tool that consumes it, and
    // `agent.ts` holds the array that makes those tools exist. The failure is
    // silent in both directions — a prompt commanding `fetch_json` at an agent
    // that never declared it produces a model apologizing for a tool it cannot
    // see, and a builtin dropped from `agent.ts` alone leaves the endpoint list
    // addressed to nothing — and neither shows up in a diff of either file.
    //
    // Which snake_case tokens in the prose are tool NAMES is a question for the
    // SDK's own schema rather than a catalog restated here: this prompt also
    // names `vs_currencies`, `include_24hr_change`, `per_person` and
    // `annual_rate`, so matching every underscored word would redden on a
    // formula. `expectPromptBuiltinsDeclared` asks the schema, and it also
    // FAILS on a prompt naming no builtin at all — the state this template lands
    // in when `system-prompt.md` is not applied, since the framework default
    // names none. The converse is deliberately not asserted: declaring a builtin
    // the prompt never mentions is an ordinary edit.
    const commanded = expectPromptBuiltinsDeclared(agentDef);
    // And the two rules above really are what the prompt commands — the helper
    // returns the list so this template can say so.
    expect(commanded).toEqual(expect.arrayContaining(["run_code", "fetch_json"]));
  });
});
