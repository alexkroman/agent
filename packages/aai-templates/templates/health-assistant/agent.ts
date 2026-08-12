import { agent, tool } from "@alexkroman1/aai";
import { z } from "zod";
import systemPrompt from "./system-prompt.md?raw";

function first(arr: string[] | undefined): string | undefined {
  return arr?.[0];
}

type FdaLabel = Record<string, unknown> & { openfda?: Record<string, string[]> };

/**
 * Fetch a drug's FDA label (generic OR brand name match) from openFDA.
 * Returns null when the drug can't be found or the API is unreachable.
 *
 * Memoized per drug name: a voice session naturally asks several questions
 * about the same drugs, and labels are static, so repeats skip the network
 * round-trip. A null result (not found, or a transient network failure) is
 * NOT cached, so the next call retries instead of pinning the failure.
 */
const labelCache = new Map<string, Promise<FdaLabel | null>>();

function fetchFdaLabel(name: string): Promise<FdaLabel | null> {
  const key = name.toLowerCase();
  let p = labelCache.get(key);
  if (!p) {
    p = fetchFdaLabelUncached(key).then((label) => {
      if (label === null) labelCache.delete(key);
      return label;
    });
    labelCache.set(key, p);
  }
  return p;
}

async function fetchFdaLabelUncached(name: string): Promise<FdaLabel | null> {
  const q = encodeURIComponent(name);
  try {
    const resp = await fetch(
      `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"+openfda.brand_name:"${q}"&limit=1`,
    );
    if (!resp.ok) return null;
    const raw = (await resp.json()) as { results?: FdaLabel[] };
    return raw.results?.[0] ?? null;
  } catch {
    return null;
  }
}

type DrugInfo = {
  /** The name the user asked about. */
  name: string;
  /** All known names, lowercased — generic + brands — used for cross-matching. */
  aliases: string[];
  /** The label's "Drug Interactions" section, lowercased. */
  interactionsText: string;
};

function toDrugInfo(name: string, label: FdaLabel): DrugInfo {
  const openfda = label.openfda ?? {};
  const generic = openfda.generic_name ?? [];
  const brands = openfda.brand_name ?? [];
  const aliases = [...new Set([name, ...generic, ...brands].map((n) => n.toLowerCase()))];
  const interactionsText = ((label.drug_interactions as string[] | undefined) ?? [])
    .join(" ")
    .toLowerCase();
  return { name, aliases, interactionsText };
}

/** Pull a short excerpt around the first mention of `alias` in `text`. */
function excerptAround(text: string, alias: string): string {
  const idx = text.indexOf(alias);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + alias.length + 200);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
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
        "Check for interactions between two or more medications using FDA drug label data. Looks up each drug's official label and reports where one drug's Drug Interactions section mentions another. Absence of a mention does not guarantee safety.",
      input: z.object({
        drugs: z
          .array(z.string().min(1))
          .min(2)
          .describe("Medication names to check, e.g. ['ibuprofen', 'warfarin']"),
      }),
      async run(args) {
        const names = args.drugs.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
        if (names.length < 2) {
          return { error: "Provide at least two medication names to check." };
        }

        const labels = await Promise.all(names.map((n) => fetchFdaLabel(n)));
        const unresolved = names.filter((_, i) => labels[i] === null);
        if (unresolved.length > 0) {
          // Never silently drop a drug from an interaction check — a partial
          // answer would read as "no interaction" for the missing one.
          return {
            error: `Could not find FDA label data for: ${unresolved.join(", ")}. Check the spelling, or try the generic name.`,
          };
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
    }),

    medication_lookup: tool({
      description:
        "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.",
      input: z.object({
        name: z
          .string()
          .describe("Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')"),
      }),
      async run(args) {
        const drug = await fetchFdaLabel(args.name);
        if (!drug) {
          return { error: `No FDA data found for: ${args.name}` };
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
