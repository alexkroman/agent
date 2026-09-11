// Copyright 2026 the AAI authors. MIT license.
/**
 * The framework's own WIRE helpers — the four `@internal` functions that used
 * to sit on `@alexkroman1/aai/utils` beside `toolFailure` and `errorMessage`.
 *
 * They were the third audience on that subpath, and the one with no business
 * being on a published one at all: nothing an agent author writes calls any of
 * them, and `contracts/internal-surface.json` had all three of its remaining
 * exemptions here — a ratchet pointing at one file. They are reachable from
 * `@alexkroman1/aai/internal`, which is where the sibling packages that DO call
 * them (`aai-server`, `aai-cli`, `aai-guest`) read the rest of their shared
 * infrastructure.
 *
 * Zod-free, like everything on that path — see `internal.ts`'s module doc for
 * why that is now a property of `/internal` as well as of `/utils`.
 */

import { MAX_TOOL_RESULT_CHARS, TOOL_RESULT_TRUNCATION_MARKER } from "./constants.ts";
import { isRecord } from "./is-record.ts";

/**
 * Cap a tool result to the client wire limit. The wire schema rejects
 * over-long `tool_call_done` results (silently dropping the whole frame), so
 * every emitter must cap through here; the provider still gets the full value.
 *
 * @internal
 */
export function capToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  // Mark the cut. A silently shortened result reads as complete data — a model
  // asked "how many variants" would count what survived and answer confidently
  // wrong — and whoever debugs it has no way to tell truncation from a short
  // record. The marker costs its own length back so the total still fits.
  return (
    result.slice(0, MAX_TOOL_RESULT_CHARS - TOOL_RESULT_TRUNCATION_MARKER.length) +
    TOOL_RESULT_TRUNCATION_MARKER
  );
}

/**
 * Coerce a tool call's input to the wire schema's args record. The AI SDK
 * surfaces an unparsable/invalid tool call as a `tool-call` part whose
 * `input` is the raw argument string (or any JSON value), not a parsed
 * object — shipping that verbatim fails the `tool_call` / sync `toolCalls`
 * schemas, which require a record. Anything that isn't a plain object
 * becomes `{}` so one bad call degrades to empty args instead of
 * invalidating the whole frame or response.
 *
 * @internal
 */
export function toArgsRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

/** Text-based client asset extensions safe to carry as a UTF-8 string. */
const TEXT_ASSET_EXTENSIONS = new Set([
  "html",
  "htm",
  "js",
  "mjs",
  "cjs",
  "css",
  "json",
  "map",
  "svg",
  "txt",
  "xml",
  "webmanifest",
]);

/**
 * Whether a client asset path holds UTF-8 text (vs. binary like png/woff2).
 * Binary assets must be base64-encoded to survive a string transport, so the
 * bundler and the server serve path both key off this shared heuristic.
 *
 * @internal
 */
export function isTextAssetPath(assetPath: string): boolean {
  const dot = assetPath.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_ASSET_EXTENSIONS.has(assetPath.slice(dot + 1).toLowerCase());
}

/**
 * Typographic characters that a text-to-speech engine should never see, mapped
 * to their ASCII equivalents.
 *
 * **Every entry must be a single UTF-16 code unit mapping to a single code
 * unit.** The heard cursor indexes a reply's TTS text by `text.length`
 * (`spans.push({ len: text.length })` in `host/transports/pipeline-heard.ts`),
 * and that index is what decides which words history records as heard and
 * where a false-interruption resume picks up. A substitution that changed
 * length would silently shift both. That rules out the tempting additions —
 * an ellipsis to three dots, a dash to a spelled word — and they are unwanted
 * anyway: `—` and `…` carry PROSODY, and TTS engines already render them as
 * pauses.
 *
 * Scoped to the quote/apostrophe family for that reason: those characters
 * carry no prosody, and they are what an LLM actually emits. Model output is
 * full of them — `You’re`, `I’ll`, `don’t` — because the training data is
 * typeset prose, and a curly apostrophe is a different codepoint from the
 * straight one every pronunciation lexicon is keyed on.
 */
const SPEECH_CHAR_MAP: ReadonlyMap<string, string> = new Map([
  ["‘", "'"], // ‘ left single quote
  ["’", "'"], // ’ right single quote — the apostrophe LLMs emit
  ["‚", "'"], // ‚ single low-9 quote
  ["‛", "'"], // ‛ single high-reversed-9 quote
  ["ʼ", "'"], // ʼ modifier letter apostrophe
  ["′", "'"], // ′ prime
  ["“", '"'], // “ left double quote
  ["”", '"'], // ” right double quote
  ["„", '"'], // „ double low-9 quote
  ["″", '"'], // ″ double prime
  ["‟", '"'], // ‟ double high-reversed-9 quote
]);

/** Character class matching every key of {@link SPEECH_CHAR_MAP}. */
const SPEECH_CHARS = /[‘’‚‛ʼ′“”„″‟]/g;

/**
 * Normalize text on its way to a TTS engine: typographic quotes and
 * apostrophes become their ASCII equivalents.
 *
 * Applied at the single point where the pipeline hands text to the provider,
 * so it covers model output, the greeting, the error phrase and the dead-air
 * filler alike.
 *
 * **Length-preserving by construction, and that is load-bearing.** The heard
 * cursor indexes a reply's TTS text by `text.length`
 * (`host/transports/pipeline-heard.ts`), and that index decides which words
 * history records as heard and where a false-interruption resume picks up, so
 * a substitution that changed length would silently shift both. Scoped to the
 * quote/apostrophe family for the same reason: `—` and `…` would break the
 * invariant, and they carry PROSODY that engines already render as pauses.
 *
 * Returns the input unchanged (same reference) when there is nothing to
 * replace, which is the common case for a reply with no contractions.
 */
export function normalizeSpeechText(text: string): string {
  SPEECH_CHARS.lastIndex = 0;
  if (!SPEECH_CHARS.test(text)) return text;
  return text.replace(SPEECH_CHARS, (c) => SPEECH_CHAR_MAP.get(c) ?? c);
}

/**
 * Spoken spelling runs, assembled into the tokens the caller meant.
 *
 * A caller reading an identifier aloud produces a transcript of isolated
 * letters — `"It's M, E, I, underscore, K, O, V, A, C, S"` — and reassembling
 * that into `mei_kovacs` was, until this function, asked of the MODEL in prose
 * (`PROMPT_LISTENING`: "normalize spoken identifiers"). Measured on a 99-task
 * tau2-bench retail run, it does it wrong often enough to be the single
 * largest failure source: `find_user_id_by_name_zip` produced 58 errors and
 * `find_user_id_by_email` 31, against 10 for every other tool combined, and
 * **22 of 57 failed calls never authenticated at all** — every one of them
 * with the correct identifier already in the caller's own words. Observed
 * mis-assemblies include `mia.garbia2723` for `mia.garcia2723`, `Johannson`
 * sent twice byte-identically for `Johansson`, and `amemia.silva` for
 * `amelia.silva`.
 *
 * Three properties make this safe to run on every transcript:
 *
 * - **It APPENDS, never replaces.** The caller's words are what history and
 *   the transcript record, and a spelling run that this function reads wrong
 *   must not destroy them. The model sees both and can still disagree.
 * - **It needs a RUN.** Three or more consecutive single letters, so ordinary
 *   speech containing "I" or "a" cannot trigger it. Prose does not spell.
 * - **It is case-folded and punctuation-free.** The assembled token is what a
 *   lookup wants, not what a sentence wants.
 *
 * Spoken separators inside a run are honoured (`underscore`, `dash`, `dot`,
 * `at`) because an identifier's shape is exactly where a model's guess goes
 * wrong — `mei_kovacs_8020` is three runs and two separators, and dropping the
 * separators is how it becomes `meikovacs8020`.
 *
 * ## The identified NEXT lever, recorded rather than built
 *
 * This function only fires on a run the caller SPELLED. The other shape a
 * mis-read identifier arrives in is one the recognizer itself formatted: the
 * same order id came back `W8855135` on some turns and `W88 55135` on another
 * in one tau2-bench retail run, and the spaced form is what the model then
 * passed to a lookup. Nothing upstream can fix that — on `universal-3-5-pro`
 * formatting is always on and is not a parameter, keyterms cannot enumerate
 * per-account ids under a 100-term cap, and `agent_context` already carries
 * the question that primed the utterance. So the remaining route is
 * normalization AFTER the wire, here: a rule that folds the spacing out of an
 * alphanumeric identifier, applied to the MODEL's copy only, like everything
 * else in this function.
 *
 * Deliberately not written yet. It is cheap, deterministic and testable
 * without a model, and it is first in the queue once the steering already
 * shipped has been graded — adding it before then is one more unevaluated arm.
 */
/** Spoken separator words that may appear INSIDE a spelling run. */
const SPELLED_SEPARATORS: Readonly<Record<string, string>> = {
  underscore: "_",
  dash: "-",
  hyphen: "-",
  dot: ".",
  period: ".",
  point: ".",
  at: "@",
};

/** Spoken digits, which an identifier's tail is usually read out as. */
const SPOKEN_DIGITS: Readonly<Record<string, string>> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/**
 * A word the RECOGNIZER already joined into one token, split back into the
 * letters the caller said — or the word itself, unchanged.
 *
 * A caller who spells a name aloud does not reliably arrive here as "s o f i
 * a": a formatted transcript renders the same speech as **`S-O-F-I-A`**, one
 * token, and the run detector that splits on whitespace and commas alone saw
 * no letters at all and assembled nothing. Observed on tau2-bench retail with
 * the caller's own correction — "Sofia Li" was heard as "Sophia Lee", the
 * caller spelled `S-O-F-I-A`, and the tool call went out as `Sophia` anyway,
 * because the annotation that would have carried the spelling was never
 * produced. The failure is ours and it is here: the caller did everything
 * right.
 *
 * The pattern needs at least THREE letter segments, so the joined forms that
 * are ordinary words survive — `e-reader` and `t-shirt` have one letter each,
 * `u-s-b` has three and is a spelling run by any reading. Periods count
 * (`u.s.a`) for the same reason the separator table has `dot`.
 */
function explodeSpelledWord(word: string): string[] {
  return /^[a-z]([-.][a-z]){2,}$/.test(word) ? word.split(/[-.]/) : [word];
}

/** One word's contribution to a run, or `undefined` when it ENDS the run. */
function spelledPiece(word: string, inRun: boolean): string | undefined {
  if (/^[a-z]$/.test(word)) return word;
  // A separator, spoken digit or bare number only ever EXTENDS a run that has
  // already started — otherwise "two things" would open one.
  if (!inRun) return undefined;
  return SPELLED_SEPARATORS[word] ?? SPOKEN_DIGITS[word] ?? (/^\d+$/.test(word) ? word : undefined);
}

export function assembleSpelledRuns(text: string): readonly string[] {
  const words = text
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .flatMap(explodeSpelledWord);
  // EVERY run, not the longest: "first name N-O-A-H, last name P-A-T-E-L" is
  // two, and the surname is the half that gets mis-assembled (`Johannson` for
  // `Johansson`, `garbia` for `garcia`). Returning one of them loses exactly
  // the token the lookup fails on.
  const runs: string[] = [];
  let run = "";
  let letters = 0;
  for (const raw of words) {
    const word = raw.replace(/[.,!?;:'"]+$/, "");
    const piece = spelledPiece(word, run !== "");
    if (piece === undefined) {
      if (letters >= 3) runs.push(run);
      run = "";
      letters = 0;
      continue;
    }
    run += piece;
    if (/^[a-z]$/.test(word)) letters++;
  }
  if (letters >= 3) runs.push(run);
  return runs;
}
