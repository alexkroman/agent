/**
 * openFDA drug labels, and the one cache both tools read.
 *
 * This module exists because the memoization below has to be shared: with a
 * cache per tool file, a session that looks a drug up and then checks it for
 * interactions pays the network round-trip twice and the "labels are static"
 * argument stops being true.
 */

import { isToolFailure } from "@alexkroman1/aai";
import { fetchJson } from "@alexkroman1/aai/tools";

export type FdaLabel = Record<string, unknown> & { openfda?: Record<string, string[]> };

export function first(arr: string[] | undefined): string | undefined {
  return arr?.[0];
}

/**
 * Memoized per drug name: a voice session naturally asks several questions
 * about the same drugs, and labels are static, so repeats skip the network
 * round-trip. A null result (not found, or a transient network failure) is
 * NOT cached, so the next call retries instead of pinning the failure.
 */
const labelCache = new Map<string, Promise<FdaLabel | null>>();

/**
 * Fetch a drug's FDA label (generic OR brand name match) from openFDA.
 * Returns null when the drug can't be found or the API is unreachable.
 */
export function fetchFdaLabel(name: string): Promise<FdaLabel | null> {
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

/**
 * One openFDA lookup, through the SDK's own REST call rather than a bare
 * `fetch`.
 *
 * `fetchJson` (`@alexkroman1/aai/tools`) is the same implementation behind the
 * model-facing `fetch_json` builtin, so this inherits the three things a bare
 * `fetch` here had none of: a request DEADLINE (`check_drug_interaction` fires
 * a `Promise.all` over one of these per drug the caller named, and a stalled
 * one held the whole tool call open for as long as the far side wanted), a
 * bounded read so an unexpected body cannot be buffered whole, and URL
 * screening on a developer's own machine under `aai dev`.
 *
 * It ANSWERS with `{ error }` rather than throwing for an HTTP failure, which
 * is the builtin contract — narrowed with `isToolFailure` and folded into the
 * same `null` this has always returned. The `catch` still earns its keep: a
 * connection failure, a timeout or a refused URL is a throw.
 */
async function fetchFdaLabelUncached(name: string): Promise<FdaLabel | null> {
  const q = encodeURIComponent(name);
  try {
    const raw = await fetchJson<{ results?: FdaLabel[] }>(
      `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"+openfda.brand_name:"${q}"&limit=1`,
    );
    if (isToolFailure(raw)) return null;
    return raw.results?.[0] ?? null;
  } catch {
    return null;
  }
}

export type DrugInfo = {
  /** The name the user asked about. */
  name: string;
  /** All known names, lowercased — generic + brands — used for cross-matching. */
  aliases: string[];
  /** The label's "Drug Interactions" section, lowercased. */
  interactionsText: string;
};

export function toDrugInfo(name: string, label: FdaLabel): DrugInfo {
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
export function excerptAround(text: string, alias: string): string {
  const idx = text.indexOf(alias);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + alias.length + 200);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
