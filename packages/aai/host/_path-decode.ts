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
 * @internal
 */
export function decodePathSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    // URIError only — `decodeURIComponent` raises nothing else.
    return undefined;
  }
}
