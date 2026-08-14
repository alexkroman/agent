import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { excerptAround, fetchFdaLabel, toDrugInfo } from "../fda.ts";

export default tool({
  description:
    "Check for interactions between two or more medications using FDA drug label data. Looks up each drug's official label and reports where one drug's Drug Interactions section mentions another. Absence of a mention does not guarantee safety.",
  inputSchema: z.object({
    drugs: z
      .array(z.string().min(1))
      .min(2)
      .describe("Medication names to check, e.g. ['ibuprofen', 'warfarin']"),
  }),
  async execute(args) {
    const names = args.drugs.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
    if (names.length < 2) {
      return toolFailure("Provide at least two medication names to check.");
    }

    const labels = await Promise.all(names.map((n) => fetchFdaLabel(n)));
    const unresolved = names.filter((_, i) => labels[i] === null);
    if (unresolved.length > 0) {
      // Never silently drop a drug from an interaction check — a partial
      // answer would read as "no interaction" for the missing one.
      return toolFailure(
        `Could not find FDA label data for: ${unresolved.join(", ")}. Check the spelling, or try the generic name.`,
      );
    }

    // The unresolved check above guarantees every label resolved.
    const drugs = names.map((name, i) => toDrugInfo(name, labels[i]!));

    const interactions: Array<{ drug: string; mentions: string; excerpt: string }> = [];
    for (const a of drugs) {
      if (!a.interactionsText) continue;
      for (const b of drugs) {
        if (a === b) continue;
        const hit = b.aliases.find((alias) => a.interactionsText.includes(alias));
        if (hit) {
          interactions.push({
            drug: a.name,
            mentions: b.name,
            excerpt: excerptAround(a.interactionsText, hit).slice(0, 400),
          });
        }
      }
    }

    return {
      drugs: names,
      interactions_found: interactions.length,
      interactions: interactions.slice(0, 5),
      note:
        interactions.length === 0
          ? "No cross-mentions found in the FDA label Drug Interactions sections. This does not guarantee the combination is safe — confirm with a pharmacist or doctor."
          : "Based on FDA label Drug Interactions sections. Confirm with a pharmacist or doctor.",
    };
  },
});
