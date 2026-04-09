export const description =
  "Check for known interactions between two or more medications. Resolves drug names via RxNorm and returns interaction details with severity levels.";

export const parameters = {
  type: "object",
  properties: {
    drugs: {
      type: "string",
      description: "Comma-separated medication names (e.g. 'ibuprofen, warfarin')",
    },
  },
  required: ["drugs"],
};

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

export default async function execute(args: { drugs: string }) {
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
}
