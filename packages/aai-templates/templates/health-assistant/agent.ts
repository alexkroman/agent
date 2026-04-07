import { defineAgent, defineTool } from "@alexkroman1/aai";
import { z } from "zod";

function first(arr: string[] | undefined): string | undefined {
  return arr?.[0];
}

const FdaOpenfdaSchema = z.record(z.string(), z.array(z.string()));

const FdaDrugSchema = z.object({
  openfda: FdaOpenfdaSchema.optional(),
  purpose: z.array(z.string()).optional(),
  indications_and_usage: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  dosage_and_administration: z.array(z.string()).optional(),
  adverse_reactions: z.array(z.string()).optional(),
}).passthrough();

const FdaResponseSchema = z.object({
  results: z.array(FdaDrugSchema).optional(),
});

async function lookupDrug(
  name: string,
): Promise<Record<string, unknown>> {
  const q = encodeURIComponent(name.toLowerCase());
  let raw: unknown;
  try {
    const resp = await fetch(
      `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"+openfda.brand_name:"${q}"&limit=1`,
    );
    raw = resp.ok ? await resp.json() : null;
  } catch {
    raw = null;
  }

  const parsed = FdaResponseSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.results?.length) {
    return { error: `No FDA data found for: ${name}` };
  }

  const drug = parsed.data.results[0]!;
  const openfda = drug.openfda ?? {};
  return {
    name: openfda["generic_name"]?.[0] ?? name,
    brand_names: openfda["brand_name"] ?? [],
    purpose: first(drug.purpose) ?? first(drug.indications_and_usage) ?? "N/A",
    warnings: first(drug.warnings)?.slice(0, 500) ?? "N/A",
    dosage: first(drug.dosage_and_administration)?.slice(0, 500) ?? "N/A",
    side_effects: first(drug.adverse_reactions)?.slice(0, 500) ?? "N/A",
    manufacturer: openfda["manufacturer_name"]?.[0] ?? "N/A",
  };
}

type RxCui = {
  name: string;
  rxcui: string;
};

async function resolveRxCui(
  name: string,
): Promise<RxCui | null> {
  let raw: { idGroup: { rxnormId?: string[] } } | null;
  try {
    const resp = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${
        encodeURIComponent(name)
      }`,
    );
    raw = resp.ok ? await resp.json() : null;
  } catch {
    raw = null;
  }
  if (!raw) return null;
  const id = raw.idGroup.rxnormId?.[0];
  return id ? { name, rxcui: id } : null;
}

async function checkInteractions(
  drugs: string,
): Promise<Record<string, unknown>> {
  const names = drugs.split(",").map((d) => d.trim().toLowerCase());

  const resolved = (await Promise.all(names.map((n) => resolveRxCui(n))))
    .filter((r): r is RxCui => r !== null);

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

  const InteractionResponseSchema = z.object({
    fullInteractionTypeGroup: z.array(z.object({
      fullInteractionType: z.array(z.object({
        interactionPair: z.array(z.object({
          description: z.string(),
          severity: z.string(),
        })).optional(),
      })).optional(),
    })).optional(),
  });

  const parsed = InteractionResponseSchema.safeParse(raw);
  const groups = parsed.success ? (parsed.data.fullInteractionTypeGroup ?? []) : [];
  const interactions = groups
    .flatMap((g) => g.fullInteractionType ?? [])
    .flatMap((t) => t.interactionPair ?? [])
    .map(({ description, severity }) => ({ description, severity }));

  return {
    drugs: resolved.map(({ name, rxcui }) => ({ name, rxcui })),
    interactions_found: interactions.length,
    interactions: interactions.slice(0, 5),
  };
}

export default defineAgent({
  name: "Dr. Sage",
  systemPrompt:
    `You are Dr. Sage, a friendly health information assistant. You help people \
understand symptoms, look up medication details, check drug interactions, and calculate \
basic health metrics.

Rules:
- You are NOT a doctor and cannot diagnose or prescribe. Always remind users to consult \
a healthcare provider for medical decisions.
- Be clear and calm when discussing symptoms — avoid alarming language
- When discussing medications, always mention common side effects
- Use plain language first, then mention the medical term
- Keep responses concise — this is a voice conversation
- If symptoms sound urgent (chest pain, difficulty breathing, sudden numbness), \
advise calling emergency services immediately
- Use web_search to look up current symptom information when needed
- Use medication_lookup to get details on a single medication
- Use check_drug_interaction to check interactions between multiple drugs

Use run_code for health calculations:
- BMI: weight_kg / (height_m * height_m). Categories: <18.5 underweight, 18.5-25 normal, 25-30 overweight, >30 obese
  Unit conversions: 1 lb = 0.453592 kg, 1 in = 0.0254 m, 1 ft = 0.3048 m, 1 cm = 0.01 m
- Weight-based dosage: dose_mg = weight_kg * dose_per_kg. Always note this is an estimate.`,
  greeting:
    "Hey, I'm Dr. Sage. Try asking me something like, what are the side effects of ibuprofen, can I take aspirin and warfarin together, or calculate my BMI. Just remember, I'm not a real doctor, so always check with your healthcare provider.",
  builtinTools: ["web_search", "run_code"],
  tools: {
    medication_lookup: defineTool({
      description:
        "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.",
      parameters: z.object({
        name: z.string().describe(
          "Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')",
        ),
      }),
      execute: ({ name }) => lookupDrug(name),
    }),
    check_drug_interaction: defineTool({
      description:
        "Check for known interactions between two or more medications. Resolves drug names via RxNorm and returns interaction details with severity levels.",
      parameters: z.object({
        drugs: z.string().describe(
          "Comma-separated medication names (e.g. 'ibuprofen, warfarin')",
        ),
      }),
      execute: ({ drugs }) => checkInteractions(drugs),
    }),
  },
});
