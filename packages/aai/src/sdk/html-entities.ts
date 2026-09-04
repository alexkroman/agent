// Copyright 2026 the AAI authors. MIT license.
/**
 * The one entity decoder, for a step that reads text off somebody else's markup.
 *
 * Two shipped templates had written it: `link-digest` as `decodeEntities`, over
 * the HTML of a page it fetches, and `podcast-digest` as `decodeXml`, over the
 * `<title>` and `<description>` of an RSS feed. The two bodies were
 * byte-identical — six `replace` calls in one order — and each carried its own
 * comment explaining the ordering, which is the tell that the ordering is the
 * whole content of the function.
 *
 * **The order is load-bearing and it is the reason this is shared rather than
 * copied.** `&amp;` has to be decoded LAST: decode it first and `&amp;lt;`
 * becomes `&lt;` becomes `<`, a tag the document never contained. A page that
 * writes about HTML — a docs site, a changelog, a Stack Overflow answer — is
 * exactly the input that hits it, so the copy that gets the order wrong looks
 * correct on every test fixture anyone writes by hand. Both templates got it
 * right and both had to argue for it in a comment; one of them getting it wrong
 * later was a matter of time.
 *
 * **Deliberately five entities and a numeric apostrophe, not the full set.**
 * There are 2,231 named HTML entities, and decoding all of them is a table and
 * a parser, i.e. a dependency. These are the ones that survive tag-stripping
 * often enough to matter, which is a claim about what a step FEEDS A MODEL: an
 * `&hellip;` reaching a prompt undecoded costs a token and confuses nobody,
 * where an `&amp;` does it on every URL. A caller that needs the full table
 * wants an HTML parser, not an option on this.
 *
 * It does NOT strip tags. Reducing markup to text is a separate and much less
 * settled job — what to do with `<script>` bodies, `<br>`, block boundaries —
 * and only one template does it, so that half stays in the template that
 * decides it.
 *
 * On `@alexkroman1/aai/utils`: this runs from a step, and `/utils`
 * is the subpath a step and a `client.tsx` can both import without pulling
 * zod's module graph.
 */

/**
 * Decode the five XML/HTML entities that matter, plus a numeric apostrophe.
 *
 * `&lt;` `&gt;` `&quot;` `&nbsp;` and `&amp;`, plus `&#39;` / `&#039;` /
 * `&apos;` for the apostrophe — the one that arrives numeric as often as named,
 * because `&apos;` is XML and not in HTML 4. A non-breaking space becomes an
 * ordinary space rather than U+00A0, since the caller is feeding text to a model
 * or a word count, and `countWords` treating the two alike is the same decision.
 *
 * Anything else is left exactly as it stands, including a malformed or unknown
 * entity: `&hellip;` and a bare `&` both come back unchanged. Decoding is a
 * single pass, so an entity produced BY the decoding is not decoded again —
 * which is the property that makes `&amp;lt;` round-trip to the literal `&lt;`
 * the document meant.
 *
 * @example
 * ```ts
 * import { decodeHtmlEntities } from "@alexkroman1/aai/utils";
 *
 * decodeHtmlEntities("Fish &amp; Chips"); // "Fish & Chips"
 * decodeHtmlEntities("it&#39;s here"); // "it's here"
 * // One pass, so an entity the decoding produced stays literal.
 * decodeHtmlEntities("&amp;lt;b&amp;gt;"); // "&lt;b&gt;"
 * ```
 *
 * @public
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY, (match) => ENTITIES[match] ?? match);
}

/**
 * Every entity in one alternation, so the replace is ONE PASS.
 *
 * The chained-`replace` version this collapses had to end on `&amp;` and say so
 * in a comment, because each call reads the previous call's output: decoding
 * `&amp;` before `&lt;` turns `&amp;lt;` into `<`. Matching all six at once
 * removes the ordering question rather than documenting it — a match is replaced
 * from the ORIGINAL text and the replacement is never rescanned, so no order of
 * the alternatives can produce a different answer.
 *
 * `&#0?39;` keeps both widths of the numeric apostrophe, which is the one entity
 * that arrives numeric more often than named.
 */
const ENTITY = /&(?:lt|gt|quot|apos|nbsp|amp|#0?39);/g;

/** What each match stands for. Keys carry their `&` and `;` — see {@link ENTITY}. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#039;": "'",
  // An ordinary space, not U+00A0: the caller is feeding a model or a word
  // count, and neither wants a character that reads as a space and is not one.
  "&nbsp;": " ",
  "&amp;": "&",
};
