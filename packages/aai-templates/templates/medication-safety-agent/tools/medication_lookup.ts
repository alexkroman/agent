import { tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { fetchFdaLabel, first } from "../fda.ts";

export default tool({
  description:
    "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.",
  inputSchema: z.object({
    name: z.string().describe("Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')"),
  }),
  async execute(args, ctx) {
    // `ctx.signal` reaches openFDA through `CallOptions`: a caller who barges in
    // or hangs up mid-lookup cancels the request rather than leaving it to run
    // out the builtin's own deadline with nobody left to tell.
    const drug = await fetchFdaLabel(args.name, { signal: ctx.signal });
    if (!drug) {
      return toolFailure(`No FDA data found for: ${args.name}`);
    }

    // Every read goes through `first`, which is where the runtime check and the
    // entity decode live — see `fda.ts`. A section openFDA served as something
    // other than an array of strings reads as absent instead of crashing the
    // tool, and `SMITH &amp; NEPHEW` is spoken as a manufacturer rather than as
    // an ampersand entity.
    const openfda = drug.openfda ?? {};
    return {
      name: first(openfda.generic_name) ?? args.name,
      brand_names: openfda.brand_name ?? [],
      purpose: first(drug.purpose) ?? first(drug.indications_and_usage) ?? "N/A",
      warnings: first(drug.warnings)?.slice(0, 500) ?? "N/A",
      dosage: first(drug.dosage_and_administration)?.slice(0, 500) ?? "N/A",
      side_effects: first(drug.adverse_reactions)?.slice(0, 500) ?? "N/A",
      manufacturer: first(openfda.manufacturer_name) ?? "N/A",
    };
  },
});
