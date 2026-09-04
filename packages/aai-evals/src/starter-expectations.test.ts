// Copyright 2026 the AAI authors. MIT license.
/**
 * The grader grading itself — an expectation is a claim about a PROMPT, so it
 * has to be checkable against that prompt.
 *
 * This was a fail-fast block at the top of `scripts/starter-eval/run.mjs`, which
 * meant it ran only when somebody spent tokens on a full eval. It is a unit test
 * now: nothing here needs a key, a studio, or a model, and the bug class it
 * catches is the one that makes an eval LIE — a required tool the prompt never
 * asks for fails a perfectly good agent, and a check that accepts prose as
 * evidence passes a broken one.
 *
 * @module
 */

import { STARTERS } from "aai-studio-client/starters";
import { describe, expect, test } from "vitest";
import {
  checkCapabilities,
  checkMode,
  checkUi,
  checkWorkflowShape,
  EXPECTATIONS,
  type Expectation,
  parseLoadedConfig,
} from "./starter-expectations.ts";
import { templateNamed } from "./template-contract.ts";

/** Every starter, flattened across the hero's two switcher positions. */
const starters = Object.values(STARTERS).flat();

/**
 * A prompt naming a template makes the TEMPLATE the ask — its files carry the
 * tools, builtins and `client.tsx` the expectation describes — so the
 * prose-consistency rules below do not apply to one.
 *
 * Reads {@link templateNamed} rather than restating its pattern: the same
 * question decides which starters this suite exempts AND which ones
 * `template-contract.ts` holds to a behaviour contract, so two copies that drift
 * grade one starter twice and another not at all.
 */
const referencesTemplate = (prompt: string): boolean => templateNamed(prompt) !== undefined;

/**
 * A starter's prompt by label.
 *
 * A map rather than the `starters.find((s) => s.label === e.label)` three checks
 * below ran inside their own loops over EXPECTATIONS — twelve times eighteen
 * comparisons each, three times over.
 */
const PROMPTS: ReadonlyMap<string, string> = new Map(starters.map((s) => [s.label, s.prompt]));
const promptFor = (label: string): string => PROMPTS.get(label) ?? "";

describe("starter expectations", () => {
  test("every expectation names a starter that exists", () => {
    const labels = new Set(starters.map((s) => s.label));
    const unknown = EXPECTATIONS.filter((e) => !labels.has(e.label)).map((e) => e.label);
    expect(unknown).toEqual([]);
  });

  test("a required UI is asked for by the prompt", () => {
    const offenders = EXPECTATIONS.filter((e) => e.ui).filter((e) => {
      const prompt = promptFor(e.label);
      return !(referencesTemplate(prompt) || /client\.tsx|custom UI/i.test(prompt));
    });
    expect(offenders.map((e) => e.label)).toEqual([]);
  });

  test("a required builtin is named by the prompt", () => {
    const offenders: string[] = [];
    for (const e of EXPECTATIONS) {
      const prompt = promptFor(e.label);
      if (referencesTemplate(prompt)) continue;
      for (const builtin of [...(e.builtins ?? []), ...(e.builtinDelegation ?? [])]) {
        if (!prompt.includes(builtin)) offenders.push(`${e.label}: ${builtin}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("builtinDelegation does not pass on prose alone", () => {
    // The other direction: a grader that says yes to everything measures
    // nothing. `builtinDelegation` accepts prose as evidence, so prove that an
    // agent carrying the prose and none of the machinery still fails.
    const offenders: string[] = [];
    for (const e of EXPECTATIONS) {
      const capabilities = e.capabilities ?? [];
      if (!e.builtinDelegation || capabilities.length === 0) continue;
      const proseOnly = `greeting: "${capabilities.map((syn) => syn[0]).join(" and ")}"`;
      const { missing } = checkCapabilities(e, { config: undefined, source: proseOnly });
      if (missing.length !== capabilities.length) offenders.push(e.label);
    }
    expect(offenders).toEqual([]);
  });

  test("the catalog is not empty, so an empty run cannot look healthy", () => {
    expect(starters.length).toBeGreaterThan(5);
    expect(EXPECTATIONS.length).toBeGreaterThan(0);
  });

  test("each sweep above has cases to sweep", () => {
    // The floor the three `offenders == []` tests need and did not have.
    //
    // Every one of them filters on a FIELD and then asserts the survivors are
    // clean. Rename `ui` to `requiresUi`, or `builtins` to `requiredBuiltins`,
    // and all three filter down to nothing, assert `[] == []`, and print green
    // — in the file whose own doc says "a grader that says yes to everything
    // measures nothing". `EXPECTATIONS.length > 0` above cannot see it, because
    // the catalog is still full; what emptied is the SELECTION.
    //
    // Floors rather than exact counts, so adding a starter never fails this,
    // and each is well under today's number (7 / 3 / 3 / 3 of 12).
    const withUi = EXPECTATIONS.filter((e) => e.ui);
    const withBuiltins = EXPECTATIONS.filter(
      (e) => (e.builtins ?? []).length > 0 || (e.builtinDelegation ?? []).length > 0,
    );
    const withDelegation = EXPECTATIONS.filter(
      (e) => e.builtinDelegation && (e.capabilities ?? []).length > 0,
    );
    expect(withUi.length, "no expectation declares `ui` — was the field renamed?").toBeGreaterThan(
      2,
    );
    expect(
      withBuiltins.length,
      "no expectation declares `builtins`/`builtinDelegation` — was a field renamed?",
    ).toBeGreaterThan(1);
    expect(
      withDelegation.length,
      "no expectation pairs `builtinDelegation` with `capabilities`, so the " +
        "prose-alone test checks nothing",
    ).toBeGreaterThan(1);
  });
});

/**
 * The half of the grader only the EVAL tier used to reach.
 *
 * `parseLoadedConfig`, `checkMode`, `checkWorkflowShape` and `checkUi` are
 * called from `starter.eval.test.ts` and nowhere else, so for as long as this
 * corpus lived under `scripts/` — outside any package's coverage report — they
 * were exercised only by a run that needs a live key and a live studio. They are
 * pure string functions; every case below is a behaviour the file's own comments
 * record having been WRONG about, which is the useful thing to pin.
 */
describe("reading a built agent", () => {
  describe("parseLoadedConfig", () => {
    test("reads the name, mode and tools out of test_agent's prose", () => {
      const config = parseLoadedConfig(
        'Bundle loaded. Agent "Pizza Line" (pipeline mode), tools: add_pizza, remove_pizza.',
      );
      expect(config).toEqual({
        name: "Pizza Line",
        mode: "pipeline",
        tools: ["add_pizza", "remove_pizza"],
      });
    });

    test("a run that never loaded a config parses to undefined", () => {
      // The distinction `checkMode` leans on: undefined means "nothing to
      // check", not "checked and fine".
      expect(parseLoadedConfig("Tests: FAILED")).toBeUndefined();
      expect(parseLoadedConfig(undefined)).toBeUndefined();
    });

    test('a tool-less agent yields an empty list, not ["(none)"]', () => {
      expect(parseLoadedConfig('Agent "Bare" (s2s mode), tools: (none).')?.tools).toEqual([]);
      expect(parseLoadedConfig('Agent "Bare" (s2s mode), tools: .')?.tools).toEqual([]);
    });
  });

  describe("checkMode", () => {
    // Only ONE claim is left here, and that is the point: the two `ok: true`
    // notes this block used to assert ("no loaded config to check",
    // "provider-less agent (pipeline default)") could never be read, because
    // `createRecorder` drops a `detail` on a check that held. See `checkMode`.
    test("a non-pipeline agent fails and the note names the mode it built", () => {
      const result = checkMode({ name: "X", mode: "s2s", tools: [] });
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/mode=s2s/);
    });

    test.each([
      ["no loaded config", undefined],
      ["a pipeline agent", { name: "X", mode: "pipeline", tools: [] }],
      // Unset stages are filled with the AssemblyAI defaults at parse time, so
      // a pipeline-mode config always carries all three and an agent that
      // declares none is legitimate rather than incomplete.
      ["a provider-less pipeline agent", { name: "X", mode: "pipeline", tools: ["a"] }],
    ] as const)("%s passes with no note", (_label, config) => {
      expect(checkMode(config)).toEqual({ ok: true });
    });
  });

  describe("checkWorkflowShape", () => {
    const complete = {
      "agent.ts": "export default workflowApp({ name: 'W' })",
      "workflows/main.ts": "export default async function run() {}",
      "client.tsx": "export default page(() => null)",
    };

    test("all four pieces present is the passing shape", () => {
      expect(checkWorkflowShape(complete)).toEqual({ ok: true });
    });

    // `test.each` rather than a loop: the reporter names the case that failed,
    // which is what the loop's `expect(result.ok, `expected a failure matching
    // ${pattern}`)` label existed to hand-roll.
    test.each([
      ["no workflowApp() declaration", { ...complete, "agent.ts": "export default agent({})" }],
      [
        "no workflows/ body",
        { "agent.ts": complete["agent.ts"], "client.tsx": complete["client.tsx"] },
      ],
      [
        "no client.tsx (the front door)",
        { "agent.ts": complete["agent.ts"], "workflows/main.ts": "x" },
      ],
      [
        "client.tsx does not mount with page()",
        { ...complete, "client.tsx": "export default client(() => null)" },
      ],
    ])("names the missing piece: %s", (problem, files) => {
      const result = checkWorkflowShape(files);
      expect(result.ok).toBe(false);
      expect(result.note).toContain(problem);
    });

    test("an empty workspace fails rather than throwing", () => {
      expect(checkWorkflowShape(undefined).ok).toBe(false);
    });
  });

  describe("checkUi", () => {
    const wantsUi: Expectation = { label: "x", capabilities: [], ui: true };

    test("a starter that never asked for a UI passes without one", () => {
      // The check the port deliberately did NOT widen: most starters ship no
      // client, and asserting one failed the math-tutor template for shipping
      // exactly what it should.
      expect(checkUi({ label: "x", capabilities: [] }, {})).toEqual({ ok: true });
      expect(checkUi(undefined, {})).toEqual({ ok: true });
    });

    test("a starter that asked for a UI fails without a client.tsx", () => {
      const result = checkUi(wantsUi, { "agent.ts": "" });
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/no client\.tsx/);
    });

    test("a client that reads no live data is decoration, not a UI", () => {
      const result = checkUi(wantsUi, { "client.tsx": "export default () => <h1>Cart</h1>" });
      expect(result.ok).toBe(false);
      expect(result.note).toMatch(/no live state/);
    });

    test("any of the four state hooks counts as live", () => {
      // `useAgentState` is listed first in the source because omitting it once
      // marked a correct Infocom client as stateless; all four must count.
      for (const hook of ["useAgentState", "useToolResult", "useEvent", "useSession"]) {
        expect(checkUi(wantsUi, { "client.tsx": `const s = ${hook}()` }), hook).toEqual({
          ok: true,
        });
      }
    });
  });

  describe("checkCapabilities reads the agent, not the agent's tests", () => {
    const expectation: Expectation = {
      label: "x",
      capabilities: [["add"], ["remove"]],
      minTools: 2,
    };

    test("a tools: { } block is brace-matched, so a nested object cannot truncate it", () => {
      // The regexed version stopped at the first `}` and lost every tool after
      // one with an inline object in it — `remove_item` here.
      const source = "agent({ tools: { add_item: tool({ schema: { a: 1 } }), remove_item: t } })";
      const report = checkCapabilities(expectation, { config: undefined, source });
      expect(report.missing).toEqual([]);
    });

    test("nested keys inside the block are counted as tools — known over-count", () => {
      // Pinned as behaviour, not endorsed: the key regex runs over the whole
      // brace-matched block, so `schema:` and `a:` below score as tools and
      // `toolCount` reads 4 for a two-tool agent. It only ever makes `minTools`
      // MORE permissive, which is why it has never failed a starter, and
      // narrowing it is a grading change rather than part of moving the file.
      const source = "agent({ tools: { add_item: tool({ schema: { a: 1 } }), remove_item: t } })";
      expect(checkCapabilities(expectation, { config: undefined, source }).toolCount).toBe(4);
    });

    test("`const x = tool(...)` declarations count too", () => {
      const report = checkCapabilities(expectation, {
        config: undefined,
        source: "const addThing = tool({}); const removeThing = tool({});",
      });
      expect(report.covered).toBe(true);
    });

    test("a tool DESCRIPTION carries a capability its identifier does not", () => {
      // The documented false negative: `use_item` described as owning puzzle
      // flags was marked `missing:puzzle` because the word was not in a name.
      const report = checkCapabilities(
        { label: "x", capabilities: [["puzzle"]] },
        {
          config: undefined,
          source: `tools: { use_item: tool({ description: "Use an item. This owns puzzle flags" }) }`,
        },
      );
      expect(report.missing).toEqual([]);
    });

    // Apostrophes in prose are why each quote style has its own character
    // class, and `test.each` is what names the style that regressed — the loop
    // this replaces labelled nothing at all.
    test.each([
      ["single", `tools: { a: tool({ description: 'sets the puzzle flag' }) }`],
      ["template", "tools: { a: tool({ description: `sets the puzzle flag` }) }"],
    ])("a description in %s quotes is evidence", (_style, source) => {
      expect(
        checkCapabilities({ label: "x", capabilities: [["puzzle"]] }, { config: undefined, source })
          .missing,
      ).toEqual([]);
    });

    test("the loaded config's tools count alongside the source's", () => {
      const report = checkCapabilities(expectation, {
        config: { name: "x", mode: "pipeline", tools: ["add_pizza", "remove_pizza"] },
        source: "",
      });
      expect(report.covered).toBe(true);
      expect(report.tooFewTools).toBe(false);
    });

    test("a missing capability is reported by its first synonym", () => {
      const report = checkCapabilities(expectation, {
        config: undefined,
        source: "tools: { add_item: t }",
      });
      expect(report.missing).toEqual(["remove"]);
      expect(report.covered).toBe(false);
    });

    test("minTools is counted over DISTINCT names", () => {
      const report = checkCapabilities(expectation, {
        config: { name: "x", mode: "pipeline", tools: ["add_item"] },
        source: "tools: { add_item: t, remove_item: t }",
      });
      expect(report.toolCount).toBe(2);
      expect(report.tooFewTools).toBe(false);
    });

    test("a named builtin the agent never declared is reported", () => {
      const report = checkCapabilities(
        { label: "x", capabilities: [], builtins: ["run_code", "web_search"] },
        { config: undefined, source: `builtinTools: ["run_code"]` },
      );
      expect(report.missingBuiltins).toEqual(["web_search"]);
      expect(report.covered).toBe(false);
    });

    test("builtinDelegation needs BOTH the builtins and the prose", () => {
      const delegating: Expectation = {
        label: "x",
        capabilities: [["convert"]],
        builtinDelegation: ["fetch_json"],
      };
      // Prose alone: no builtins declared, so the prose is not consulted.
      expect(
        checkCapabilities(delegating, {
          config: undefined,
          source: "greeting: 'I convert currency'",
        }).missing,
      ).toEqual(["convert"]);
      // Builtins alone: nothing tells the model what to reach for them for.
      expect(
        checkCapabilities(delegating, { config: undefined, source: `builtinTools: ["fetch_json"]` })
          .missing,
      ).toEqual(["convert"]);
      // Both halves.
      expect(
        checkCapabilities(delegating, {
          config: undefined,
          source: `builtinTools: ["fetch_json"]; greeting: 'I convert currency'`,
        }).missing,
      ).toEqual([]);
    });
  });
});
