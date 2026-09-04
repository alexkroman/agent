import { isToolFailure } from "@alexkroman1/aai";
import { toolInputIssues, toolRunner } from "@alexkroman1/aai/testing";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { excerptAround, type FdaLabel, toDrugInfo } from "./fda.ts";

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

describe("health-assistant template", () => {
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
});

describe("medication_lookup", () => {
  test("folds the label's array fields into one flat answer", async () => {
    label.mockResolvedValue(IBUPROFEN);
    const result = await run("medication_lookup", { name: "advil" });
    expect(result).toMatchObject({
      name: "IBUPROFEN",
      brand_names: ["Advil"],
      purpose: "Pain reliever",
      manufacturer: "Acme",
    });
  });

  test("an unknown drug is a tool FAILURE, not an empty answer", async () => {
    // The model has to be able to tell "no such drug" from "a drug with no
    // warnings", which is why this is a failure rather than a record of "N/A".
    label.mockResolvedValue(null);
    const result = await run("medication_lookup", { name: "sparkleforin" });
    expect(isToolFailure(result) && result.error).toContain("sparkleforin");
  });

  test("a missing section reads N/A rather than undefined", async () => {
    label.mockResolvedValue(WARFARIN);
    expect(await run("medication_lookup", { name: "warfarin" })).toMatchObject({
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
    const result = await run("check_drug_interaction", { drugs: ["ibuprofen", "warfarin"] });
    expect(result).toMatchObject({ interactions_found: 1 });
    const [first] = (result as { interactions: { drug: string; mentions: string }[] }).interactions;
    expect(first).toMatchObject({ drug: "ibuprofen", mentions: "warfarin" });
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
    const result = await run("check_drug_interaction", { drugs: ["ibuprofen", "warfarin"] });
    expect(result).toMatchObject({ interactions_found: 1 });
  });

  test("a drug that cannot be resolved REFUSES the whole check", async () => {
    // The rule that makes this tool safe to have: a partial answer would read
    // as "no interaction" for the drug that was silently dropped.
    label.mockImplementation(async (name: string) =>
      name.includes("ibuprofen") ? IBUPROFEN : null,
    );
    const result = await run("check_drug_interaction", { drugs: ["ibuprofen", "sparkleforin"] });
    expect(isToolFailure(result) && result.error).toContain("sparkleforin");
  });

  test("two drugs with no cross-mention are reported as such, with the caveat", async () => {
    label.mockResolvedValue(WARFARIN);
    const result = await run("check_drug_interaction", { drugs: ["warfarin", "aspirin"] });
    expect(result).toMatchObject({ interactions_found: 0 });
    expect((result as { note: string }).note).toContain("does not guarantee");
  });

  test("whitespace-only names are refused before any lookup happens", async () => {
    // The schema's `min(2)` counts entries, not real names, so the body
    // re-checks after trimming — and must do so BEFORE touching the network.
    const result = await run("check_drug_interaction", { drugs: ["ibuprofen", "   "] });
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
