export const description =
  "Look up detailed information about a single medication, including purpose, warnings, dosage, side effects, and manufacturer. Works with both generic and brand names.";

export const parameters = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Medication name (generic or brand, e.g. 'ibuprofen' or 'Advil')",
    },
  },
  required: ["name"],
};

function first(arr: string[] | undefined): string | undefined {
  return arr?.[0];
}

export default async function execute(args: { name: string }) {
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
    dosage: first(drug.dosage_and_administration as string[] | undefined)?.slice(0, 500) ?? "N/A",
    side_effects: first(drug.adverse_reactions as string[] | undefined)?.slice(0, 500) ?? "N/A",
    manufacturer: openfda.manufacturer_name?.[0] ?? "N/A",
  };
}
