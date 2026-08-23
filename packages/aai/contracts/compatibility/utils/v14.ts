// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 14.
 *
 * **Epoch 14 ADDS one function, `decodeHtmlEntities`.** Nothing was removed and
 * no signature narrowed, so epoch 13 is RETAINED and `./v13.ts` compiles
 * unchanged beside this file.
 *
 * It is here for the same reason the four narration formatters joined at epoch
 * 13 — two shipped templates had each written it, and it landed on `/utils`
 * because that is the subpath a `"use step"` body and a `client.tsx` can both
 * import. `link-digest` called it `decodeEntities` over the HTML of a page it
 * fetches; `podcast-digest` called it `decodeXml` over the `<title>` and
 * `<description>` of an RSS feed. The bodies were byte-identical.
 *
 * **And like those four, what is frozen here is the OUTPUT**, because the whole
 * content of the function is an ordering rule. `&amp;` must be decoded LAST, or
 * `&amp;lt;` becomes `&lt;` becomes `<` — a tag the document never contained, in
 * text about to be handed to a model. Both templates got it right and both had
 * to argue for it in a comment; the assertions below are that promise, written
 * the way a caller writes it, so a rewrite that reintroduces the double decode
 * fails here rather than on somebody's docs site.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  countWords,
  createKeyedLock,
  decodeHtmlEntities,
  errorDetail,
  errorMessage,
  formatBytes,
  formatDuration,
  isRecord,
  omitUndefined,
  plural,
  pushCapped,
  safeJsonParse,
  withLock,
} from "../../../sdk/utils.ts";

/** Unchanged from epoch 13: an append-only list held to a cap in place. */
export function note(log: string[], line: string): string[] {
  return pushCapped(log, line, 50);
}

/** Unchanged from epoch 13: reading a field off a body nobody has validated. */
export function readState(text: string): string | undefined {
  const body = safeJsonParse(text);
  if (!isRecord(body)) return undefined;
  return typeof body.state === "string" ? body.state : undefined;
}

/** Unchanged from epoch 13: the optional half under `exactOptionalPropertyTypes`. */
export function describe(name?: string, note?: string): Record<string, string> {
  return { kind: "order", ...omitUndefined({ name, note }) };
}

/** Unchanged from epoch 13: serializing work per key. */
const lock = createKeyedLock();

export async function chargeOnce(orderId: string, charge: () => Promise<string>): Promise<string> {
  try {
    return await withLock(lock, orderId, charge);
  } catch (err: unknown) {
    return `${errorMessage(err)} (${errorDetail(err).length} chars of detail)`;
  }
}

/** Unchanged from epoch 13: one sentence, written once, for a step and a page. */
export function narrate(bytes: number, ms: number, transcript: string): string {
  const words = countWords(transcript);
  return (
    `Transcribed ${formatBytes(bytes)} of audio (${formatDuration(ms)}) into ` +
    `${words} ${plural(words, "word")}.`
  );
}

/**
 * New at epoch 14, and the shape the whole change exists for: a step reducing
 * somebody else's markup to text a model should read.
 *
 * The decode comes AFTER the tag stripping, which is the order that matters:
 * decoding first would turn an escaped `&lt;b&gt;` in the page's prose into a
 * tag the next `replace` then deletes.
 */
export function articleText(html: string): string {
  return decodeHtmlEntities(
    html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The output is the promise, so a caller pins it. Each of these is a documented
 * case rather than a sample: the ampersand every URL carries, both widths of the
 * numeric apostrophe, an unknown entity left exactly as it stands — and the one
 * the whole function exists for, a double-encoded entity peeling exactly ONE
 * layer, which is what a chained-`replace` version gets wrong the moment
 * somebody reorders the calls.
 */
export const pinned: readonly string[] = [
  decodeHtmlEntities("?x=1&amp;y=2"), // "?x=1&y=2"
  decodeHtmlEntities("it&#39;s"), // "it's"
  decodeHtmlEntities("it&#039;s"), // "it's"
  decodeHtmlEntities("a&nbsp;b"), // "a b" — a plain space, not U+00A0
  decodeHtmlEntities("&hellip;"), // "&hellip;" — not in the table, left alone
  decodeHtmlEntities("&amp;lt;b&amp;gt;"), // "&lt;b&gt;", never "<b>"
];
