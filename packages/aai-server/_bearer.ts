// Copyright 2026 the AAI authors. MIT license.
/**
 * The 401 SENTENCE for a bearer that did not resolve. The parse itself is
 * `parseBearer` on `@alexkroman1/aai-runtime/internal`.
 *
 * This module used to hold both, and its own doc recorded why it could not
 * share the parse: "Two other copies of this parse exist and are NOT fixed
 * here — `aai-runtime/workflow-api-http.ts` and `aai-guest/harness-auth.ts`
 * … Neither is reachable from this module (`aai-server` may not be imported by
 * either), so closing them means a shared helper one layer down rather than an
 * import."
 *
 * That helper now exists — `aai-runtime/bearer.ts`, published on
 * `@alexkroman1/aai-runtime/internal` — and both copies are fixed against it.
 * The unstated half was that this package can import that subpath too: it
 * already does in five modules (`logger.ts` takes `consoleLogger` from it), so
 * keeping a fourth copy here was buying nothing. It is deleted, and this module
 * is the message alone.
 *
 * **A local re-export was considered and rejected.** `_static-files.ts` does
 * pass `isPathInside` through, but it does so for a cohesive helper its
 * consumers use alongside its own reader. Here it would make one function
 * importable under two paths inside one package — which is the shape the
 * three-copies bug grew out of, and which this repo's own rule about
 * `/internal` ("a name is there because something IMPORTS it") argues against.
 * The two callers take the parse from where it lives.
 *
 * @module
 */

/**
 * The 401 sentence for a request whose bearer did not resolve.
 *
 * `parseBearer` collapses two different failures into `""`, and for a long time
 * so did the reply: a request carrying a present, well-formed
 * `authorization: bearer <key>` was answered "Missing Authorization header",
 * which names a cause that is not the cause. That is the expensive half of a
 * fail-closed parse — the operator reads the message, adds the header they
 * already sent, and the real difference (a capitalisation, or a `Basic` scheme)
 * is never mentioned. The scheme match is fixed in the shared helper; this
 * keeps the two answers apart for everything still legitimately refused.
 *
 * Deliberately says nothing about WHICH scheme was seen. The header is
 * attacker-controlled and this string goes into a response body, so echoing it
 * back would be a reflection; naming the scheme we accept is the actionable
 * half anyway.
 */
export function bearerFailureMessage(header: string | null | undefined): string {
  return (header ?? "").trim() === ""
    ? "Missing Authorization header (Bearer <API_KEY>)"
    : "Malformed Authorization header (expected `Bearer <API_KEY>`)";
}
