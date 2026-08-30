// Copyright 2026 the AAI authors. MIT license.
/**
 * Percent-decoding a piece of a request path — the one spelling.
 *
 * `decodeURIComponent` THROWS a `URIError` on a malformed escape, and a request
 * target is attacker-supplied: `GET /.well-known/workflow/v1/webhook/%` is a
 * legal HTTP request that nothing in the stack rejects before a handler cuts the
 * path apart. Five call sites here decoded a segment, in three different
 * accidental safety regimes — one caught explicitly, three sat inside an `async`
 * router whose rejection is caught and answered 500, and **one was fully
 * synchronous** (`webhookToken` → `pickWorkflowHandler` → `handleWorkflowRequest`,
 * called from `createServer`'s `options.request?.(…)` hook with no `try`). That
 * one reached the guest's `uncaughtException` guard and `process.exit(4)`,
 * unauthenticated, taking every concurrent voice session on the sandbox down
 * with it.
 *
 * A second class arrives the same way and needs the same answer: `%00` is a
 * well-formed escape, so it decodes rather than throwing, and the NUL then
 * reaches a store that has no reading for it — see the function's own doc.
 *
 * So the decode is a FUNCTION with a stated contract rather than an expression
 * repeated with different luck: `undefined` means "this is not a decodable path
 * segment", and every caller answers it the way its own route answers a bad
 * request — a 400, a 404, or a decline. There is no spelling of this that
 * throws.
 *
 * It belongs beside `requestPath` in `sdk/request-url.ts` and lives here only
 * because every caller is host-side; moving it there is a pure relocation.
 */

/**
 * Percent-decode one piece of a request path, or `undefined` when it is not
 * decodable.
 *
 * A lone `%`, a truncated escape (`%A`), or bytes that are not valid UTF-8
 * (`%C0%80`) all answer `undefined`. Callers must never re-throw it: the input
 * is the caller's raw request target.
 *
 * **A NUL answers `undefined` too, and it is the interesting one**: `%00` is a
 * WELL-FORMED escape, so it decoded cleanly and walked past the guard above
 * into whatever the segment addresses — where Postgres refuses a NUL in text
 * and the failure came back as `500 Internal server error` for what is a
 * malformed request target. Measured under `aai dev` against a real database:
 * `GET` and `DELETE /workflows/runs/wrun_%00` and
 * `GET /session-events/tt%00sess` all 500, and `…/wrun_%00/events` spent its
 * whole read-retry budget before reporting `idle`. Only the upload routes
 * escaped it, because those check an id GRAMMAR of their own first — which is
 * the same argument as this, one layer up.
 *
 * NUL alone, deliberately. Every other control character is ordinary text to
 * every store here and 404s correctly (verified across `%01`, `%07`-`%0d`,
 * `%1b`, `%7f`), so widening this to the C0 range would reject inputs nothing
 * has trouble with. NUL is the character with no legal reading anywhere in this
 * repo's stack — the same property that made three source files invisible to
 * `git grep`.
 *
 * @internal
 */
export function decodePathSegment(raw: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // URIError only — `decodeURIComponent` raises nothing else.
    return undefined;
  }
  return decoded.includes("\u0000") ? undefined : decoded;
}
