// Copyright 2026 the AAI authors. MIT license.
/**
 * Word alignment for the heard cursor (`pipeline-heard.ts`): locating a TTS
 * provider's reported words inside the text handed to it, and snapping a
 * character estimate back to a word boundary.
 *
 * Split out of `pipeline-heard.ts` for the file-length cap, on the seam it
 * already had: everything here is a pure function of a string and a word
 * timeline, and none of it knows about the playback clock or a reply.
 */

import type { TtsWordTiming } from "@alexkroman1/aai/host-internal";

/**
 * One lowercase ASCII letter or digit.
 *
 * Module scope for the reason `normalizeUtterance` hoists its own: {@link normChar}
 * is called once per character of both sides of `alignWords`, a few thousand times
 * per barge-in, and a literal in the body is a fresh `RegExp` each time. No `g`
 * flag, so there is no `lastIndex` to share.
 */
const ASCII_ALPHANUMERIC = /[a-z0-9]/;

/** Lowercased alphanumeric projection of one character, or `undefined`. */
function normChar(c: string | undefined): string | undefined {
  if (c === undefined) return;
  const lower = c.toLowerCase();
  return ASCII_ALPHANUMERIC.test(lower) ? lower : undefined;
}

/** Alphanumeric-only, casefolded projection of a word. */
function normWord(word: string): string {
  let out = "";
  for (const c of word) {
    const n = normChar(c);
    if (n !== undefined) out += n;
  }
  return out;
}

/**
 * Index just past `target` in `text` at or after `from`, comparing only
 * casefolded alphanumerics so the provider's normalization ("$5.00" → "five
 * dollars" is hopeless, but "5.00" → "500" and "Dr." → "dr" are not) does not
 * break the alignment outright.
 */
function findWordEnd(text: string, target: string, from: number): number | undefined {
  if (target.length === 0) return;
  for (let start = from; start < text.length; start++) {
    if (normChar(text[start]) === undefined) continue;
    let ti = 0;
    let i = start;
    while (i < text.length && ti < target.length) {
      const c = normChar(text[i]);
      i++;
      if (c === undefined) continue;
      if (c !== target[ti]) {
        ti = -1;
        break;
      }
      ti++;
    }
    if (ti === target.length) return i;
  }
}

/**
 * Character offset just past each reported word, or `-1` where the word could
 * not be located in the text.
 *
 * Alignment can fail on normalization even with a perfect parse (a provider
 * that speaks "$5.00" as "five dollars" reports words that are simply not in
 * the text), so a miss is recorded rather than fatal: the reader falls back to
 * the last aligned word, and failing that to the proportional estimate — never
 * worse than having no timings at all.
 */
export function alignWords(text: string, words: readonly TtsWordTiming[]): number[] {
  const ends: number[] = [];
  let cursor = 0;
  for (const word of words) {
    const end = findWordEnd(text, normWord(word.text), cursor);
    if (end === undefined) {
      ends.push(-1);
      continue;
    }
    cursor = end;
    ends.push(end);
  }
  return ends;
}

/**
 * Index of the last word whose audio had WHOLLY elapsed by `ms` (`endMs`, not
 * `startMs` — a half-spoken word was not heard), or `-1` for none.
 */
export function lastHeardWord(words: readonly TtsWordTiming[], ms: number): number {
  let last = -1;
  for (let i = 0; i < words.length; i++) {
    if ((words[i]?.endMs ?? 0) > ms) break;
    last = i;
  }
  return last;
}

/** Character offset of the last ALIGNED word at or before `last`, or `-1`. */
export function alignedEnd(ends: readonly number[], last: number): number {
  for (let i = last; i >= 0; i--) {
    const end = ends[i] ?? -1;
    if (end >= 0) return end;
  }
  return -1;
}

/**
 * Snap a character index back to the word boundary at or before it, so a cut
 * never lands mid-word. Returns `index` unchanged when the prefix holds no
 * boundary at all (the cut is inside the reply's first word), which is the
 * behaviour the proportional estimate has always had.
 */
export function snapToWord(text: string, index: number): number {
  // At or past the end there is nothing to snap: the whole text was heard, and
  // snapping would drop the reply's last word from the record.
  if (index >= text.length) return text.length;
  // Already ON a boundary — moving back would drop a whole word for nothing.
  if (/\s/.test(text[index] ?? "")) return index;
  const head = text.slice(0, index);
  const boundary = head.lastIndexOf(" ");
  return boundary > 0 ? boundary : head.length;
}
