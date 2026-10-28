// Copyright 2026 the AAI authors. MIT license.
/**
 * `appendDictation(draft, text)` — where dictated words land in a text box
 * that may already hold some.
 */

/**
 * `draft` with `text` added after it, joined by exactly one space: a draft
 * ending in whitespace or a newline does not grow a double space, and an empty
 * or blank draft is replaced rather than given a leading one.
 *
 * Never REPLACES what was typed — the words someone said are an addition to
 * the box, which is what makes speaking into a half-written prompt safe.
 *
 * @example
 * ```ts
 * import { appendDictation } from "@alexkroman1/aai-ui";
 *
 * appendDictation("Build me an agent", "that books tables."); // "Build me an agent that books tables."
 * appendDictation("", "Hello"); // "Hello"
 * ```
 *
 * @public
 */
export function appendDictation(draft: string, text: string): string {
  const words = text.trim();
  if (!words) return draft;
  return draft.trim() ? `${draft.trimEnd()} ${words}` : words;
}
