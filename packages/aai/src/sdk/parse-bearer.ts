// Copyright 2026 the AAI authors. MIT license.
/**
 * Parsing an `Authorization: Bearer <token>` header, once.
 *
 * There were THREE copies of this line — `aai-server/_bearer.ts`,
 * `workflow/api/http.ts`'s `bearerMatches` and `aai-guest/harness-auth.ts`'s
 * `bearerToken` — and all three matched the scheme CASE-SENSITIVELY, so a client
 * sending the spec-legal `authorization: bearer <key>` resolved to nothing and
 * every gate refused it. A fourth, `apiKeyRoute`'s own regex, lived in `sdk/`
 * because the route helper may not reach `host/`; so the parse lives here, with
 * no Node import, and `host/bearer.ts` (on `/host-internal`) re-exports it
 * beside the Node-side constant-time compare.
 *
 * @module parse-bearer
 */

/**
 * The `auth-scheme` this parses, lower-cased for comparison.
 *
 * RFC 7235 §2.1 makes `auth-scheme` **case-insensitive** ("Note that both
 * scheme and parameter names are case-insensitive"), so the comparison below
 * lower-cases the header's first token rather than testing for the one
 * capitalisation this repo happens to send.
 *
 * Only the SCHEME is case-insensitive. The credential is `token68`, which is
 * case-SENSITIVE and is never touched here.
 */
const BEARER_SCHEME = "bearer ";

/**
 * Token from an `Authorization: Bearer <token>` header value.
 *
 * Returns `""` when the header is absent or is not a Bearer credential — the
 * caller decides what an empty token means (401, `null`, a refusal). `""` rather
 * than `null` because every caller has to handle "no token" anyway and a union
 * makes a constant-time comparison read as two cases.
 *
 * The credentials are TRIMMED, because `credentials = auth-scheme 1*SP token68`
 * permits more than one space and `token68` cannot contain one — so `Bearer  key`
 * is one legal spelling of one token, where slicing a fixed seven characters
 * yielded `" key"`, a *different* token that then failed every comparison.
 *
 * The one deliberate divergence from `aai-server/_bearer.ts` is that this has no
 * `bearerFailureMessage` twin: no caller here distinguishes "absent" from
 * "malformed" in its reply — the guest answers 401 with a fixed sentence and the
 * workflow API answers a boolean — so a second function would be a surface with
 * no reader.
 */
export function parseBearer(header: string | null | undefined): string {
  if (header === null || header === undefined) return "";
  // Only the scheme is lower-cased — never the whole header, which would
  // destroy the credential it is wrapped around.
  if (header.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return "";
  return header.slice(BEARER_SCHEME.length).trim();
}
