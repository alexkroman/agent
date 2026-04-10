import { agent, tool } from "aai";
import { z } from "zod";
import systemPrompt from "./system-prompt.md";

type RxCui = { name: string; rxcui: string };

async function resolveRxCui(name: string): Promise<RxCui | null> {
  let raw: { idGroup: { rxnormId?: string[] } } | null;
  try {
    const resp = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(name)}`,
    );
    raw = resp.ok ? await resp.json() : null;
  } catch {
    raw = null;
  }
  if (!raw) return null;
  const id = raw.idGroup.rxnormId?.[0];
  return id ? { name, rxcui: id } : null;
}

function first(arr: string[] | undefined): string | undefined {
  return arr?.[0];
}

export default agent({
  name: "Dr. Sage",
  systemPrompt,
  greeting:
    "Hey, I'm Dr. Sage. Try asking me something like, what are the side effects of ibuprofen, can I take aspirin and warfarin together, or calculate my BMI. Just remember, I'm not a real doctor, so always check with your healthcare provider.",
  builtinTools: ["web_search", "run_code"],

  tools: {
    check_drug_interaction: tool({
      description:
        "Check for known interactions between two or more medications. Resolves drug names via RxNorm and returns interaction details with severity levels.",
      parameters: z.object({
        drugs: z.string().describe("Comma-separated medication names (e.g. 'ibuprofen, warfarin')"),
      }),
      async execute(args) {
        const names = args.drugs.split(",").map((d) => d.trim().toLowerCase());

        const resolved = (await Promise.all(names.map((n) => resolveRxCui(n)))).filter(
          (r): r is RxCui => r !== null,
        );

        if (resolved.length < 2) {
          return {
            error: `Could not resolve all drug names. Found: ${
              resolved.map((r) => r.name).join(", ") || "none"
            }`,
          };
        }

        const rxcuiList = resolved.map((r) => r.rxcui).join("+");
        let raw: Record<string, unknown>;
        try {
          const resp = await fetch(
            `https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis=${rxcuiList}`,
          );
          raw = resp.ok ? await resp.json() : { error: "Interaction lookup failed" };
        } catch {
          raw = { error: "Interaction lookup failed" };
        }

        if ("error" in raw) return raw;

        type InteractionPair = { description: string; severity: string };
        type InteractionType = { interactionPair?: InteractionPair[] };
        type InteractionGroup = { fullInteractionType?: InteractionType[] };

        const groups: InteractionGroup[] =
          (raw as { fullInteractionTypeGroup?: InteractionGroup[] }).fullInteractionTypeGroup ?? [];

        const interactions = groups
          .flatMap((g) => g.fullInteractionType ?? [])
          .flatMap((t) => t.interactionPair ?? [])
          .map(({ description, severity }) => ({ description, severity }));

        return {
          drugs: resolved.map(({ name, rxcui }) => ({ name, rxcui })),
          interactions_found: interactions.length,
          interactions: interactions.slice(0, 5),
        };
      },
    }),

    medication_lookup: tool({
      description:
        "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.",
      parameters: z.object({
        name: z
          .string()
          .describe("Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')"),
      }),
      async execute(args) {
        const q = encodeURIComponent(args.name.toLowerCase());
        let raw: Record<string, unknown> | null;
        try {
          const resp = await fetch(
            `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"+openfda.brand_name:"${q}"&limit=1`,
          );
          raw = resp.ok ? await resp.json() : null;
        } catch {
          raw = null;
        }

        if (
          !(raw && Array.isArray((raw as { results?: unknown[] }).results)) ||
          ((raw as { results?: unknown[] }).results?.length ?? 0) === 0
        ) {
          return { error: `No FDA data found for: ${args.name}` };
        }

        const drug = (raw as { results: Record<string, unknown>[] }).results[0] as Record<
          string,
          unknown
        >;
        const openfda = (drug.openfda ?? {}) as Record<string, string[]>;
        return {
          name: openfda.generic_name?.[0] ?? args.name,
          brand_names: openfda.brand_name ?? [],
          purpose:
            first(drug.purpose as string[] | undefined) ??
            first(drug.indications_and_usage as string[] | undefined) ??
            "N/A",
          warnings: first(drug.warnings as string[] | undefined)?.slice(0, 500) ?? "N/A",
          dosage:
            first(drug.dosage_and_administration as string[] | undefined)?.slice(0, 500) ?? "N/A",
          side_effects:
            first(drug.adverse_reactions as string[] | undefined)?.slice(0, 500) ?? "N/A",
          manufacturer: openfda.manufacturer_name?.[0] ?? "N/A",
        };
      },
    }),
  },
});
