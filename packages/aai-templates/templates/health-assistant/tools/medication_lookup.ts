import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { fetchFdaLabel, first } from "../fda.ts";

export default tool({
  description:
    "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.",
  inputSchema: z.object({
    name: z.string().describe("Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')"),
  }),
  async execute(args) {
    const drug = await fetchFdaLabel(args.name);
    if (!drug) {
      return toolFailure(`No FDA data found for: ${args.name}`);
    }

    const openfda = drug.openfda ?? {};
    return {
      name: openfda.generic_name?.[0] ?? args.name,
      brand_names: openfda.brand_name ?? [],
      purpose:
        first(drug.purpose as string[] | undefined) ??
        first(drug.indications_and_usage as string[] | undefined) ??
        "N/A",
      warnings: first(drug.warnings as string[] | undefined)?.slice(0, 500) ?? "N/A",
      dosage: first(drug.dosage_and_administration as string[] | undefined)?.slice(0, 500) ?? "N/A",
      side_effects: first(drug.adverse_reactions as string[] | undefined)?.slice(0, 500) ?? "N/A",
      manufacturer: openfda.manufacturer_name?.[0] ?? "N/A",
    };
  },
});
