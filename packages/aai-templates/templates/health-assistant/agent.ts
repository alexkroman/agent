import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import systemPrompt from "./system-prompt.md";

type RxCui = { name: string; rxcui: string };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url);
    return resp.ok ? ((await resp.json()) as T) : null;
  } catch {
    return null;
  }
}

async function resolveRxCui(name: string): Promise<RxCui | null> {
  const raw = await getJson<{ idGroup: { rxnormId?: string[] } }>(
    `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(name)}`,
  );
  if (!raw) return null;
  const id = raw.idGroup.rxnormId?.[0];
  return id ? { name, rxcui: id } : null;
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

        type InteractionPair = { description: string; severity: string };
        type InteractionType = { interactionPair?: InteractionPair[] };
        type InteractionGroup = { fullInteractionType?: InteractionType[] };

        const raw = await getJson<{ fullInteractionTypeGroup?: InteractionGroup[] }>(
          `https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis=${rxcuiList}`,
        );
        if (!raw) return { error: "Interaction lookup failed" };

        const groups: InteractionGroup[] = raw.fullInteractionTypeGroup ?? [];

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
        const raw = await getJson<{ results?: Record<string, unknown>[] }>(
          `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"+openfda.brand_name:"${q}"&limit=1`,
        );

        const drug = raw?.results?.[0];
        if (!drug) {
          return { error: `No FDA data found for: ${args.name}` };
        }

        const openfda = (drug.openfda ?? {}) as Record<string, string[]>;
        const str = (field: unknown): string | undefined => (field as string[] | undefined)?.[0];
        return {
          name: openfda.generic_name?.[0] ?? args.name,
          brand_names: openfda.brand_name ?? [],
          purpose: str(drug.purpose) ?? str(drug.indications_and_usage) ?? "N/A",
          warnings: str(drug.warnings)?.slice(0, 500) ?? "N/A",
          dosage: str(drug.dosage_and_administration)?.slice(0, 500) ?? "N/A",
          side_effects: str(drug.adverse_reactions)?.slice(0, 500) ?? "N/A",
          manufacturer: openfda.manufacturer_name?.[0] ?? "N/A",
        };
      },
    }),
  },
});
