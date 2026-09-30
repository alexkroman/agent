// Copyright 2026 the AAI authors. MIT license.
/**
 * A failure, as a short reason a person can HEAR.
 *
 * A workflow that says its result on a speaker has to say its failure too, or
 * a failed run is silence — and the raw `err.message` is the wrong thing to
 * say. It runs to paragraphs (a provider's refusal quotes its whole request),
 * it carries URLs nobody can act on out loud, and it can quote a credential: a
 * `?key=` in the URL a fetch failed on, a bearer token echoed back in a 401
 * body. Every app that announced failures wrote the same four lines to cut it
 * down, and the copies disagreed about which parameters counted as secret.
 *
 * Its own module rather than a body in `utils.ts`, which re-exports it: that
 * file is near the length cap, and this is one decision with its own test.
 */

import { isRecord } from "./is-record.ts";

/** The default {@link SpokenErrorReasonOptions.max}. */
const DEFAULT_MAX_CHARS = 160;

/** What a credential is replaced with. */
const REDACTED = "[redacted]";

/** What {@link spokenErrorReason} says when nothing sayable is left. */
const FALLBACK_REASON = "something went wrong";

/**
 * `name=value` pairs whose VALUE is a credential — in a query string or bare in
 * prose ("invalid api_key=sk-…"). Matched case-insensitively, on a word
 * boundary, so `monkey=1` is not a `key`.
 */
const SECRET_PAIR_RE =
  /\b(api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|sig|signature|auth|authorization)=([^&\s"',;]+)/gi;

/** `Bearer <token>` / `Basic <creds>`, as an echoed `Authorization` header reads. */
const AUTH_SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

/** Vendor-shaped API keys that turn up in a refusal with no `name=` in front. */
const BARE_KEY_RE = /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_])?[A-Za-z0-9_-]{12,}/g;

/** A URL: noise when read aloud, and where a credential usually rides. */
const URL_RE = /\b(?:https?|wss?):\/\/[^\s<>"')\]]+/gi;

/**
 * Options for {@link spokenErrorReason}.
 *
 * @public
 */
export type SpokenErrorReasonOptions = {
  /**
   * The most characters the reason may run to, cut on a word boundary where
   * there is one. Defaults to 160 — about one spoken sentence.
   */
  max?: number;
};

/**
 * Turn a failure into a short reason a person can hear: its FIRST sentence,
 * with credentials redacted and URLs removed, capped at about one spoken
 * sentence.
 *
 * What a workflow's failure announcement says after "Sorry, I couldn't finish
 * that:". Redacts `key=`/`token=`/`secret=`/`password=`/`sig=` values (in a
 * query string or bare), `Bearer`/`Basic` credentials and vendor-shaped keys
 * (`sk-…`), drops URLs entirely, and answers `"something went wrong"` when
 * nothing sayable is left. Never throws, whatever it is handed.
 *
 * @example
 * ```ts
 * import { spokenErrorReason } from "@alexkroman1/aai/utils";
 *
 * const why = spokenErrorReason(
 *   new Error("Request to https://api.example.com/v1?key=abc123 failed with 403. Retry later."),
 * );
 * // "Request to failed with 403."
 * void why;
 * ```
 *
 * @param err - Anything thrown — an `Error`, a string, an object.
 * @param options - `max` caps the length (default 160).
 * @returns A trimmed, non-empty reason.
 * @public
 */
export function spokenErrorReason(err: unknown, options: SpokenErrorReasonOptions = {}): string {
  const max = Math.max(1, Math.floor(options.max ?? DEFAULT_MAX_CHARS));
  // URLs FIRST, whole: a redaction marker inside one would end the URL match
  // early and leave the rest of its query string behind.
  const redacted = messageOf(err)
    .replace(URL_RE, "")
    .replace(SECRET_PAIR_RE, (_match, name: string) => `${name}=${REDACTED}`)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(BARE_KEY_RE, REDACTED)
    // What removing a URL leaves: empty brackets and a space before punctuation.
    .replace(/\(\s*\)|<\s*>|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
  // The first sentence: a terminator FOLLOWED by whitespace, so a host name
  // (`api.example.com`) or a version (`v1.2`) is not a sentence end.
  const first = (redacted.split(/(?<=[.!?])\s/)[0] ?? redacted).trim();
  const capped = capAtWord(first, max);
  return capped.length > 0 ? capped : FALLBACK_REASON;
}

/**
 * The message of anything thrown, as text. Local rather than `errorMessage`
 * from `utils.ts`, which re-exports this module: importing back would be a
 * cycle.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (isRecord(err) && typeof err.message === "string") return err.message;
  try {
    return String(err);
  } catch {
    return "";
  }
}

/** `text` cut to `max` characters, on the last word boundary when there is one. */
function capAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  // A boundary in the first half would throw away most of the reason; cut hard.
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "").trim();
}
