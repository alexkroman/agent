import {
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  type ToolFailure,
} from "@alexkroman1/aai";
import {
  expectDeployable,
  expectPromptBuiltinsDeclared,
  toolInputIssues,
  toolRunner,
} from "@alexkroman1/aai/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { excerptAround, type FdaLabel, toDrugInfo } from "./fda.ts";
import type CheckDrugInteraction from "./tools/check_drug_interaction.ts";
import type MedicationLookup from "./tools/medication_lookup.ts";

/**
 * Only the NETWORK half of `fda.ts` is faked.
 *
 * `fetchFdaLabel` is the one function in this template that leaves the process,
 * so it is the one thing a unit test may not run — everything the tools are
 * actually about (the cross-mention scan, the refuse-on-a-missing-drug rule,
 * the field folding) is pure and stays real. `importActual` rather than a whole
 * module stub for exactly that reason: a fully mocked `fda.ts` would leave
 * `toDrugInfo` returning `undefined` and the tools passing over nothing.
 */
vi.mock("./fda.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fda.ts")>()),
  fetchFdaLabel: vi.fn(),
}));

const { fetchFdaLabel } = await import("./fda.ts");
const label = vi.mocked(fetchFdaLabel);

/** The def a DEPLOYED agent runs: authored, plus what `tools/` declares. */
import agentDef from "virtual:aai/agent";

/**
 * Every tool here takes arguments and none of them touches session state, so no
 * call passes a context: `runTool` builds a fresh one per call, which is a
 * distinct session — right for a stateless tool, and never what two calls
 * sharing state want.
 */
const run = toolRunner(agentDef);

/**
 * The two tools, reached through their OWN input types.
 *
 * `run` takes `Record<string, unknown>`, so `run("medication_lookup", { drug:
 * "advil" })` compiles and fails at run time as a schema rejection — in the one
 * spec that is supposed to be the worked example of calling this tool.
 * `InferToolInput` reads the argument type off the tool's `execute`, which is
 * the zod schema the tool really declares, so a renamed or retyped field breaks
 * the BUILD here and the two files cannot drift apart quietly.
 *
 * The imports are TYPE-only, deliberately: the defs under test still come from
 * `agentDef`, which is what a deploy resolves, and nothing here re-registers a
 * tool module by importing it.
 */
const lookUp = (args: InferToolInput<typeof MedicationLookup>) => run("medication_lookup", args);
const check = (args: InferToolInput<typeof CheckDrugInteraction>) =>
  run("check_drug_interaction", args);

/**
 * What `check_drug_interaction` answers when it did NOT refuse.
 *
 * `run` is typed `unknown` — the registry lookup is by string — so reading a
 * field off the answer needs an assertion either way. `InferToolOutput` makes
 * it an assertion about the tool's OWN return type rather than a shape retyped
 * beside it, so renaming `interactions_found` reddens here instead of quietly
 * comparing `undefined`. The SDK's `expectToolOk` is deliberately not used: it
 * unwraps a `dialog()` envelope and throws for a plain `tool()`, which both of
 * these are.
 */
type CheckResult = Exclude<InferToolOutput<typeof CheckDrugInteraction>, ToolFailure>;

const IBUPROFEN: FdaLabel = {
  openfda: { generic_name: ["IBUPROFEN"], brand_name: ["Advil"], manufacturer_name: ["Acme"] },
  purpose: ["Pain reliever"],
  warnings: ["Stomach bleeding warning"],
  dosage_and_administration: ["One tablet every 6 hours"],
  adverse_reactions: ["Nausea"],
  drug_interactions: ["Ask a doctor before use if taking WARFARIN, a blood thinner."],
};

const WARFARIN: FdaLabel = {
  openfda: { generic_name: ["WARFARIN SODIUM"], brand_name: ["Coumadin"] },
  purpose: ["Anticoagulant"],
};

beforeEach(() => {
  // `restoreMocks` restores `vi.spyOn` mocks; it does not clear a `vi.fn()`'s
  // history or its implementation, so an implementation set by one test would
  // otherwise still be installed in the next.
  label.mockReset();
});

describe("medication-safety-agent template", () => {
  test("both tools are discovered from tools/", () => {
    // `agent()` takes no `tools` field: a file in `tools/` IS the tool. A
    // template whose tools are never resolved ships a model with none.
    // `arrayContaining` rather than an exact list: a tool you add is the edit
    // this template invites, and it must not redden a test you did not write.
    // Losing one of these two still fails, which is the regression worth
    // catching — discovery silently finding nothing looks exactly like a
    // template with no tools.
    expect(Object.keys(agentDef.tools ?? {})).toEqual(
      expect.arrayContaining(["check_drug_interaction", "medication_lookup"]),
    );
  });

  test("is deployable: validates, is nameable, and every stage its mode needs is filled", () => {
    // The same conversion `aai build`/`aai deploy` run, and the only thing that
    // checks the three builtin NAMES against the SDK's own enum — so a typo in
    // `builtinTools` fails here rather than shipping an agent whose prompt
    // commands a tool the platform never resolved. This template declares no
    // provider at all, so the default all-AssemblyAI cascade is what makes it
    // run the moment it is deployed; `expectDeployable` asserts that per MODE,
    // so it survives a swap. `not.toThrow()` because the helper's throw IS the
    // finding: vitest quotes the message, which names the invariant that went.
    expect(() => expectDeployable(agentDef)).not.toThrow();
  });

  test("all three builtins survive into the config a deploy carries", () => {
    const builtins = expectDeployable(agentDef).builtinTools ?? [];

    // Asserted on the CONFIG rather than the def because that is what a deploy
    // ships, and because `DEFAULT_BUILTIN_TOOLS` is empty: a builtin is
    // something an agent asks for, never something it has to notice and switch
    // off. So a dropped entry is not a quieter Dr. Sage — it is the same one
    // with a prompt rule addressed to nothing. Adding builtins beside these
    // three is an ordinary edit; losing one is the regression.
    //
    // `run_code` is the arithmetic rule's only mechanism (a BMI or a
    // weight-based dose worked out in the model's head reads exactly like a
    // computed one), `web_search` the only route to current symptom
    // information, and `fetch_json` the only route to the adverse-event
    // dataset — which is a COUNTING query the two `tools/` files cannot
    // answer, since they read the label endpoint and a label is what the
    // manufacturer wrote.
    expect(builtins).toEqual(expect.arrayContaining(["web_search", "run_code", "fetch_json"]));
  });

  test("every builtin the prompt tells Dr. Sage to use is one it declares", () => {
    // The pairing this template's prose is built on: the prompt holds the
    // formulas, the endpoint and the caveats, each list headed by the tool that
    // consumes it, and `agent.ts` holds the array that makes those tools exist.
    // The failure is silent in both directions and shows up in a diff of
    // neither file — a prompt commanding `fetch_json` at an agent that never
    // declared it produces a model apologizing for a tool it cannot see, and a
    // builtin dropped from `agent.ts` alone leaves the endpoint addressed to
    // nothing.
    //
    // Which snake_case tokens in the prose are tool NAMES is a question for the
    // SDK's own schema rather than a catalog restated here: this prompt also
    // names `weight_kg`, `dose_mg`, `medication_lookup` and
    // `patient.reaction.reactionmeddrapt.exact`, so matching every underscored
    // word would redden on a formula or a query field.
    // `expectPromptBuiltinsDeclared` asks the schema, and it also FAILS on a
    // prompt naming no builtin at all — the state this template lands in when
    // `system-prompt.md` was not applied, since the framework default names
    // none. The converse is deliberately not asserted: declaring a builtin the
    // prompt never mentions is an ordinary edit.
    expect(expectPromptBuiltinsDeclared(agentDef)).toEqual(
      expect.arrayContaining(["web_search", "run_code", "fetch_json"]),
    );
  });
});

describe("medication_lookup", () => {
  test("folds the label's array fields into one flat answer", async () => {
    label.mockResolvedValue(IBUPROFEN);
    const result = await lookUp({ name: "advil" });
    expect(result).toMatchObject({
      name: "IBUPROFEN",
      brand_names: ["Advil"],
      purpose: "Pain reliever",
      manufacturer: "Acme",
    });
    // And the lookup carried the caller's `ctx.signal` down to openFDA — the
    // `CallOptions` half. A tool that forgets it leaves a request running past
    // the turn that wanted it, which nothing else here would notice.
    expect(label.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("an unknown drug is a tool FAILURE, not an empty answer", async () => {
    // The model has to be able to tell "no such drug" from "a drug with no
    // warnings", which is why this is a failure rather than a record of "N/A".
    label.mockResolvedValue(null);
    const result = await lookUp({ name: "sparkleforin" });
    expect(isToolFailure(result) && result.error).toContain("sparkleforin");
  });

  test("a missing section reads N/A rather than undefined", async () => {
    label.mockResolvedValue(WARFARIN);
    expect(await lookUp({ name: "warfarin" })).toMatchObject({
      warnings: "N/A",
      dosage: "N/A",
      side_effects: "N/A",
      manufacturer: "N/A",
    });
  });
});

describe("check_drug_interaction", () => {
  test("reports a cross-mention with the excerpt that justifies it", async () => {
    label.mockImplementation(async (name: string) =>
      name.includes("ibuprofen") ? IBUPROFEN : WARFARIN,
    );
    const result = (await check({ drugs: ["ibuprofen", "warfarin"] })) as CheckResult;
    expect(result.interactions_found).toBe(1);
    expect(result.interactions[0]).toMatchObject({ drug: "ibuprofen", mentions: "warfarin" });
  });

  test("matches on a BRAND alias, not only the name the caller used", async () => {
    // `toDrugInfo` folds generic and brand names into one alias list precisely
    // so a label naming "Coumadin" still matches a caller who said "warfarin".
    const coumadinMention: FdaLabel = {
      openfda: { generic_name: ["IBUPROFEN"] },
      drug_interactions: ["Do not combine with COUMADIN."],
    };
    label.mockImplementation(async (name: string) =>
      name.includes("ibuprofen") ? coumadinMention : WARFARIN,
    );
    const result = await check({ drugs: ["ibuprofen", "warfarin"] });
    expect(result).toMatchObject({ interactions_found: 1 });
  });

  test("a drug that cannot be resolved REFUSES the whole check", async () => {
    // The rule that makes this tool safe to have: a partial answer would read
    // as "no interaction" for the drug that was silently dropped.
    label.mockImplementation(async (name: string) =>
      name.includes("ibuprofen") ? IBUPROFEN : null,
    );
    const result = await check({ drugs: ["ibuprofen", "sparkleforin"] });
    expect(isToolFailure(result) && result.error).toContain("sparkleforin");
  });

  test("two drugs with no cross-mention are reported as such, with the caveat", async () => {
    label.mockResolvedValue(WARFARIN);
    const result = (await check({ drugs: ["warfarin", "aspirin"] })) as CheckResult;
    expect(result.interactions_found).toBe(0);
    // The caveat is the point of the zero case: "no cross-mention" is not
    // "safe", and this tool must never be read as saying it was.
    expect(result.note).toContain("does not guarantee");
  });

  test("every drug in the fan-out is looked up under the caller's signal", async () => {
    // The reason `fetchFdaLabel` takes `CallOptions` at all: this tool fires one
    // request per drug the caller named, so a hang-up mid-check has N of them
    // to take down, not one.
    label.mockResolvedValue(WARFARIN);

    await check({ drugs: ["warfarin", "aspirin"] });

    expect(label).toHaveBeenCalledTimes(2);
    for (const [, options] of label.mock.calls) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("whitespace-only names are refused before any lookup happens", async () => {
    // The schema's `min(2)` counts entries, not real names, so the body
    // re-checks after trimming — and must do so BEFORE touching the network.
    const result = await check({ drugs: ["ibuprofen", "   "] });
    expect(isToolFailure(result) && result.error).toContain("at least two");
    expect(label).not.toHaveBeenCalled();
  });

  test("the schema itself accepts those names, which is why the body re-checks", async () => {
    // The other half of the claim above, asked of the schema directly rather
    // than through `~standard`: `min(2)` counts ENTRIES and `min(1)` counts
    // CHARACTERS, so `"   "` is a valid entry and the refusal is the body's.
    expect(
      await toolInputIssues(agentDef, "check_drug_interaction", { drugs: ["ibuprofen", "   "] }),
    ).toBeUndefined();
    // And the schema is still doing its own half — one drug is not a check.
    expect(
      await toolInputIssues(agentDef, "check_drug_interaction", { drugs: ["ibuprofen"] }),
    ).toBeDefined();
  });
});

describe("fda.ts helpers", () => {
  test("toDrugInfo lowercases every alias so cross-matching is case-blind", () => {
    const info = toDrugInfo("advil", IBUPROFEN);
    expect(info.aliases).toEqual(["advil", "ibuprofen"]);
    expect(info.interactionsText).toContain("warfarin");
  });

  test("excerptAround ellipsizes only the ends it actually cut", () => {
    const text = `${"a".repeat(300)}warfarin${"b".repeat(300)}`;
    const excerpt = excerptAround(text, "warfarin");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerptAround("warfarin", "warfarin")).toBe("warfarin");
  });
});
