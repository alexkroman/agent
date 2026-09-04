// Copyright 2026 the AAI authors. MIT license.
/**
 * Parsing an `Authorization: Bearer <token>` header, once — and the one thing
 * that parse's return type obliges every caller to check ({@link isBlankSecret}).
 *
 * There were THREE copies of this line — `aai-server/_bearer.ts`,
 * `workflow-api-http.ts`'s `bearerMatches` and `aai-guest/harness-auth.ts`'s
 * `bearerToken` — and all three matched the scheme CASE-SENSITIVELY, so a client
 * sending the spec-legal `authorization: bearer <key>` resolved to nothing and
 * every gate refused it. `aai-server`'s copy was fixed first and could not be
 * shared: neither of the other two may import that package. This is the "one
 * layer down" its module doc points at.
 *
 * It lives in `aai-runtime` rather than in `@alexkroman1/aai/host-internal`
 * because that is the NARROWEST home that reaches both remaining call sites —
 * `workflow-api-http.ts` is in this package, and `aai-guest` already depends on
 * it and imports nine other names from `@alexkroman1/aai-runtime/internal`.
 * Putting it in the SDK would publish it to every package in the repo, including
 * the two browser bundles that have no `Authorization` header to parse.
 *
 * @module bearer
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
 * makes the constant-time comparison below it read as two cases.
 *
 * The credentials are TRIMMED, because `credentials = auth-scheme 1*SP token68`
 * permits more than one space and `token68` cannot contain one — so `Bearer  key`
 * is one legal spelling of one token, where slicing a fixed seven characters
 * yielded `" key"`, a *different* token that then failed every comparison.
 *
 * The one deliberate divergence from `aai-server/_bearer.ts` is that this has no
 * `bearerFailureMessage` twin: neither caller here distinguishes "absent" from
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

/**
 * Is `secret` a value no caller can ever legitimately PRESENT?
 *
 * This exists because of {@link parseBearer}'s codomain, which is why it lives
 * here rather than at either gate. That function maps three different requests —
 * no header at all, a header that is not a Bearer credential, and a Bearer
 * credential whose token68 is empty — onto the same `""`. So `""` on the
 * PRESENTED side never means "the caller presented the empty token"; it means
 * "there was no token". An expected secret of `""` is therefore not a credential
 * a caller can satisfy, only one a caller who presented NOTHING accidentally
 * equals.
 *
 * **And it did.** `AAI_WORKFLOW_API_TOKEN=` or `AAI_SESSION_EVENTS_TOKEN=` — set
 * but empty, which `SecretUpdatesSchema` (`z.record(SecretKeySchema, z.string())`)
 * accepts from the studio's Secrets pane — made `timingSafeEqual` compare two
 * empty buffers, which MATCH. Both gates guarded `token === undefined` and
 * neither guarded `token === ""`, so a variable whose whole purpose is to require
 * a credential turned authentication OFF: measured, `GET /session-events/:id`
 * answered 200 with the conversation to a request carrying no `Authorization`
 * header at all.
 *
 * Whitespace-only counts as blank for the same reason and no further one:
 * `parseBearer` TRIMS, so `"   "` is likewise not in its codomain — a
 * whitespace-only secret is a secret nothing can present, i.e. no secret. The
 * line stops there deliberately. A merely PADDED secret (`" x "`) is also
 * unpresentable, and is NOT reported blank, because the callers below act on this
 * answer by falling back to their default posture — and for the workflow API that
 * default is OPEN, so widening this predicate past "no secret at all" would let a
 * typo open a surface instead of closing it.
 */
export function isBlankSecret(secret: string | null | undefined): boolean {
  return secret === null || secret === undefined || secret.trim() === "";
}
