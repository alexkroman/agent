/**
 * openFDA drug labels, and the one cache both tools read.
 *
 * This module exists because the memoization below has to be shared: with a
 * cache per tool file, a session that looks a drug up and then checks it for
 * interactions pays the network round-trip twice and the "labels are static"
 * argument stops being true.
 */

import { type CallOptions, fetchJson } from "@alexkroman1/aai/tools";
import { decodeHtmlEntities, isToolFailure } from "@alexkroman1/aai/utils";

/**
 * One openFDA label document.
 *
 * `Record<string, unknown>` rather than `fetchJson`'s own `UntypedJsonBody`,
 * which looks like the obvious fit and is the wrong one here: that alias is
 * `Record<string, DefaultToolResult>` and `DefaultToolResult` is `any`, so its
 * index signature would win the intersection below and `label.openfda` — the
 * ONE field this file knows the shape of — would stop being checked at all.
 * `unknown` is the same "nothing validated this" claim with the checking left
 * on; the two readers under it are what make it usable at a call site.
 */
export type FdaLabel = Record<string, unknown> & { openfda?: Record<string, string[]> };

/**
 * The first string of a label section, decoded.
 *
 * Takes `unknown` rather than `string[] | undefined`, which is what retires the
 * seven `as string[] | undefined` casts this file and `medication_lookup` used
 * to spell at every section read. Each was an assertion about a THIRD PARTY's
 * document that openFDA does not honour uniformly — `effective_time`, `id` and
 * `version` are bare strings, not arrays — so the cast was a lie one field away
 * from being read, and the check that replaces it is a line.
 *
 * The decode is `decodeHtmlEntities` (`@alexkroman1/aai/utils`): label text is
 * lifted out of SPL XML and arrives with its entities intact (`SMITH &amp;
 * NEPHEW`, `it&#39;s`), and everything this module returns is read ALOUD — an
 * `&amp;` is a word the desk says.
 */
export function first(value: unknown): string | undefined {
  const [head] = sectionLines(value);
  return head === undefined ? undefined : decodeHtmlEntities(head);
}

/**
 * A whole label section as one decoded string.
 *
 * A section arrives as an ARRAY, and openFDA splits a long one across entries,
 * so a reader that takes only the first (see {@link first}) would scan half of
 * a Drug Interactions section for a cross-mention and report the other half as
 * absent — which for this template reads as "no interaction found".
 */
export function sectionText(value: unknown): string {
  return decodeHtmlEntities(sectionLines(value).join(" "));
}

/** A label section as the strings it really holds, dropping anything that is not one. */
function sectionLines(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
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
 *
 * `options` is the SDK's own `CallOptions`, and a tool passes `ctx.signal`
 * through it: `check_drug_interaction` fans one request out per drug the caller
 * named, and without a signal the only bound on any of them is the builtin's
 * own deadline — a caller who hangs up or barges in mid-check leaves every one
 * of those requests running. Passing the signal is also why the type is the
 * SDK's rather than a local `{ signal?: AbortSignal }`: the option belongs to
 * `fetchJson`, and restating it here is how the two drift.
 *
 * The signal the FIRST caller passes governs the shared request, which is the
 * right answer for the shape this template actually has — the concurrent
 * lookups all come from one tool call, so they abort together — and an aborted
 * lookup is evicted below like any other failure, so the next turn retries.
 */
export function fetchFdaLabel(name: string, options?: CallOptions): Promise<FdaLabel | null> {
  const key = name.toLowerCase();
  let p = labelCache.get(key);
  if (!p) {
    p = fetchFdaLabelUncached(key, options).then((label) => {
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
 * `fetch` here had none of: a request DEADLINE, a bounded read so an unexpected
 * body cannot be buffered whole, and URL screening on a developer's own machine
 * under `aai dev`.
 *
 * It ANSWERS with `{ error }` rather than throwing for an HTTP failure, which
 * is the builtin contract — narrowed with `isToolFailure` and folded into the
 * same `null` this has always returned. The `catch` still earns its keep: a
 * connection failure, a timeout, a refused URL or the caller's own abort is a
 * throw.
 */
async function fetchFdaLabelUncached(
  name: string,
  options?: CallOptions,
): Promise<FdaLabel | null> {
  const q = encodeURIComponent(name);
  try {
    const raw = await fetchJson<{ results?: FdaLabel[] }>(
      `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${q}"+openfda.brand_name:"${q}"&limit=1`,
      options,
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
  const interactionsText = sectionText(label.drug_interactions).toLowerCase();
  return { name, aliases, interactionsText };
}

/** Pull a short excerpt around the first mention of `alias` in `text`. */
export function excerptAround(text: string, alias: string): string {
  const idx = text.indexOf(alias);
  const start = Math.max(0, idx - 100);
  const end = Math.min(text.length, idx + alias.length + 200);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
