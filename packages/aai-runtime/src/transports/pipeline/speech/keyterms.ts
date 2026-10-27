// Copyright 2026 the AAI authors. MIT license.
/**
 * Keyterms for the STT, harvested from what the agent's tools returned.
 *
 * Once a lookup has answered, the words the caller is about to say are on the
 * record: their name, the products in their orders, the cities they ship to.
 * The STT does not know that, and hears the nearest common words instead —
 * recorded on tau2-bench retail: "pet bed" committed as "MedBed" (the agent
 * then found no such item and returned the wrong ones), and "Rossi" as "Rafi",
 * "Rafsi" and "Roffi" across six failed lookups. Feeding the record's proper
 * nouns back as keyterms is the standard fix (AssemblyAI's `keyterms_prompt`,
 * updatable mid-stream).
 *
 * What counts as a term is a SHAPE, not a vocabulary: a string leaf of a JSON
 * tool result that is 3-50 characters of letters, spaces, apostrophes,
 * hyphens and periods, at most four words, with a capital letter somewhere.
 * That keeps "Pet Bed", "Isabella", "Johansson" and "Houston", and drops ids,
 * codes, snake_case keys, sentences and lowercase option values ("leather",
 * "pending"), which the STT hears fine as ordinary words. Nothing here reads
 * what the CALLER said.
 */

import { isRecord } from "@alexkroman1/aai/utils";

/** AssemblyAI's per-session limits for `keyterms_prompt`. @internal */
export const MAX_KEYTERMS = 100;
/** @internal */
export const MAX_KEYTERM_CHARS = 50;

const TERM_SHAPE = /^[\p{L}][\p{L}'’. -]*$/u;

/** Is this string a name-like term worth biasing the STT toward? @internal */
export function isKeyterm(value: string): boolean {
  const v = value.trim();
  if (v.length < 3 || v.length > MAX_KEYTERM_CHARS) return false;
  if (!(TERM_SHAPE.test(v) && /\p{Lu}/u.test(v))) return false;
  return v.split(/\s+/).length <= 4;
}

/** Every keyterm-shaped string leaf in a tool result, in document order. @internal */
export function keytermsIn(result: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return [];
  }
  return stringLeaves(parsed)
    .filter(isKeyterm)
    .map((s) => s.trim());
}

/** Every string leaf of a parsed JSON value, in document order. */
function stringLeaves(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(stringLeaves);
  return isRecord(node) ? Object.values(node).flatMap(stringLeaves) : [];
}

/** @internal */
export interface KeytermHarvester {
  /** Fold one tool result in; pushes the new set to the STT when it changed. */
  observe(result: string): void;
}

/**
 * Keep the most recent {@link MAX_KEYTERMS} distinct terms across the call and
 * push the whole set on every change — the service REPLACES the set on each
 * update, so a partial push would drop the rest.
 *
 * @internal
 */
export function createKeytermHarvester(
  update: (terms: readonly string[]) => void,
): KeytermHarvester {
  const terms = new Map<string, string>(); // lowercased -> as written, oldest first
  return {
    observe(result) {
      let changed = false;
      for (const term of keytermsIn(result)) {
        const key = term.toLowerCase();
        if (terms.has(key)) {
          terms.delete(key); // re-inserted below: most recent last
        } else {
          changed = true;
        }
        terms.set(key, term);
      }
      while (terms.size > MAX_KEYTERMS) {
        const oldest = terms.keys().next().value;
        if (oldest === undefined) break;
        terms.delete(oldest);
        changed = true;
      }
      if (changed) update([...terms.values()]);
    },
  };
}
