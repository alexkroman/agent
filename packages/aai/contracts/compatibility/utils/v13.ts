// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:utils` epoch 13.
 *
 * **Epoch 13 ADDS the four narration formatters** — `formatBytes`,
 * `formatDuration`, `countWords` and `plural`. Nothing was removed and no
 * signature narrowed, so epoch 12 is RETAINED and `./v12.ts` compiles unchanged
 * beside this file.
 *
 * They are on `/utils` rather than a subpath of their own because of who writes
 * them: a `workflows/*.ts` step narrating its own progress, and the `client.tsx`
 * rendering the same run — and `/utils` is already the import both halves reach
 * for. Every template that reported progress had grown a private copy of each
 * (four of `mb()`, five of `clock()`/`duration()`, four of `countWords()`,
 * seventeen inline `${n === 1 ? "" : "s"}`), split across the server and browser
 * sides of ONE project. That duplication was already producing wrong output: one
 * template printed a 64-minute recording as `1:04:09` from its workflow and
 * `64:09` from its page.
 *
 * **What is frozen here is the OUTPUT**, which is unusual for this tree and is
 * the reason these belong on a contract at all. Each returns one fixed ASCII
 * shape, deliberately un-localized — `Intl` answers to the host's ICU default,
 * so the same run would render differently on a laptop and in a sandbox — so a
 * spec may assert the exact string and a page and a step cannot disagree about
 * the same run. The assertions below are that promise, written as a caller
 * writes it.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import {
  countWords,
  createKeyedLock,
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

/** Unchanged from epoch 12: an append-only list held to a cap in place. */
export function note(log: string[], line: string): string[] {
  return pushCapped(log, line, 50);
}

/** Unchanged from epoch 12: reading a field off a body nobody has validated. */
export function readState(text: string): string | undefined {
  const body = safeJsonParse(text);
  if (!isRecord(body)) return undefined;
  return typeof body.state === "string" ? body.state : undefined;
}

/** Unchanged from epoch 12: the optional half under `exactOptionalPropertyTypes`. */
export function describe(name?: string, note?: string): Record<string, string> {
  return { kind: "order", ...omitUndefined({ name, note }) };
}

/** Unchanged from epoch 12: serializing work per key. */
const lock = createKeyedLock();

export async function chargeOnce(orderId: string, charge: () => Promise<string>): Promise<string> {
  try {
    return await withLock(lock, orderId, charge);
  } catch (err: unknown) {
    return `${errorMessage(err)} (${errorDetail(err).length} chars of detail)`;
  }
}

/**
 * New at epoch 13, and the shape the whole change exists for: ONE sentence,
 * written once, called from the step that reports it and from the page that
 * renders the finished run. Neither side owns a copy, so neither can drift.
 */
export function narrate(bytes: number, ms: number, transcript: string): string {
  const words = countWords(transcript);
  return (
    `Transcribed ${formatBytes(bytes)} of audio (${formatDuration(ms)}) into ` +
    `${words} ${plural(words, "word")}.`
  );
}

/**
 * The output is the promise, so a caller pins it. Every one of these is a
 * documented case rather than a sample: unit promotion (1024 * 1023.6 is
 * `"1.0 MB"`, never `"1024 KB"`), the hours field that only appears when it is
 * needed, the empty string a bare `split(/\s+/)` would count as one word, and
 * that only exactly `1` takes the singular.
 */
export const pinned: readonly string[] = [
  formatBytes(0), // "0 B"
  formatBytes(112_640), // "110 KB"
  formatDuration(249_000), // "4:09"
  formatDuration(3_849_000), // "1:04:09"
  plural(0, "risk"), // "risks"
  plural(1, "entry", "entries"), // "entry"
];

export const emptyIsZeroWords: number = countWords("   ");
