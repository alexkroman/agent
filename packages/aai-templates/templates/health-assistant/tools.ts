function first(arr: string[] | undefined): string | undefined {
  return arr?.[0];
}

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

  if (!raw || typeof raw !== "object") {
    return { error: `No FDA data found for: ${name}` };
  }

  const data = raw as Record<string, unknown>;
  const results = data.results as Record<string, unknown>[] | undefined;
  if (!results?.length) {
    return { error: `No FDA data found for: ${name}` };
  }

  const drug = results[0] as Record<string, unknown>;
  const openfda = (drug.openfda ?? {}) as Record<string, string[]>;
  const purpose = drug.purpose as string[] | undefined;
  const indications = drug.indications_and_usage as string[] | undefined;
  const warnings = drug.warnings as string[] | undefined;
  const dosage = drug.dosage_and_administration as string[] | undefined;
  const adverse = drug.adverse_reactions as string[] | undefined;

  return {
    name: openfda["generic_name"]?.[0] ?? name,
    brand_names: openfda["brand_name"] ?? [],
    purpose: first(purpose) ?? first(indications) ?? "N/A",
    warnings: first(warnings)?.slice(0, 500) ?? "N/A",
    dosage: first(dosage)?.slice(0, 500) ?? "N/A",
    side_effects: first(adverse)?.slice(0, 500) ?? "N/A",
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

  const groups = (
    (raw as Record<string, unknown>).fullInteractionTypeGroup as
      { fullInteractionType?: { interactionPair?: { description: string; severity: string }[] }[] }[] | undefined
  ) ?? [];
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

export default {
  tools: {
    medication_lookup: {
      description:
        "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')",
          },
        },
        required: ["name"],
      },
      execute: (args: Record<string, unknown>) => lookupDrug(args.name as string),
    },
    check_drug_interaction: {
      description:
        "Check for known interactions between two or more medications. Resolves drug names via RxNorm and returns interaction details with severity levels.",
      parameters: {
        type: "object",
        properties: {
          drugs: {
            type: "string",
            description:
              "Comma-separated medication names (e.g. 'ibuprofen, warfarin')",
          },
        },
        required: ["drugs"],
      },
      execute: (args: Record<string, unknown>) =>
        checkInteractions(args.drugs as string),
    },
  },
} satisfies AgentTools;
