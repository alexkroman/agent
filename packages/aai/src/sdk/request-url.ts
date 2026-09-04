// Copyright 2026 the AAI authors. MIT license.
/**
 * Split a Node request target into its path and its query — the one spelling.
 *
 * `req.url` is the raw request TARGET (`/runs/abc?wait=5`), not a URL, so every
 * handler that wants either half has to cut it itself. This package had cut it
 * at thirteen sites, three different ways, and one of the three is WRONG:
 *
 * ```ts no-check
 * new URLSearchParams((req.url ?? "").split("?")[1] ?? "")   // truncating
 * new URLSearchParams(raw.slice(raw.indexOf("?") + 1))       // correct
 * new URL(req.url ?? "/", "http://localhost").searchParams   // correct, allocates
 * ```
 *
 * `split("?")[1]` keeps only the segment BETWEEN the first and second `?`, so a
 * query value carrying a literal `?` is silently truncated —
 * `?namespace=a?b` reads as `a`. `sdk/ws-upgrade.ts` already documented that
 * hazard and worked around it with `indexOf`, in a comment nothing else could
 * see; the other six query sites did not.
 *
 * The path half has the mirror-image problem: `String.prototype.split` never
 * returns an empty array, so `split("?")[0]` is always a string and every
 * `?? "/"` / `?? ""` / `?? url` after one is dead code that exists only to
 * satisfy `noUncheckedIndexedAccess`. Four different dead fallbacks across the
 * package invited the reader to work out which of them was load-bearing. None
 * was.
 *
 * Neither function looks for a `#`. A request target has no fragment (RFC 9112
 * §3.2 — the client strips it before sending), so cutting at one would describe
 * an input that cannot arrive, and `new URL`'s fragment handling was incidental
 * to reaching for a URL parser rather than something a caller asked for.
 *
 * @module request-url
 */

/**
 * The path half of a request target: everything before the first `?`.
 *
 * `undefined` — which is how `http.IncomingMessage.url` is typed — answers
 * `"/"`, the same thing an origin-form target with no path means.
 *
 * @internal
 */
export function requestPath(rawUrl: string | undefined): string {
  if (rawUrl === undefined || rawUrl.length === 0) return "/";
  const query = rawUrl.indexOf("?");
  return query === -1 ? rawUrl : rawUrl.slice(0, query);
}

/**
 * The query half of a request target, parsed.
 *
 * Sliced from the FIRST `?` rather than split on every one, so a value holding
 * a literal `?` survives. A target with no query answers an empty
 * `URLSearchParams`, so a caller never branches on presence.
 *
 * @internal
 */
export function requestQuery(rawUrl: string | undefined): URLSearchParams {
  if (rawUrl === undefined) return new URLSearchParams();
  const query = rawUrl.indexOf("?");
  return new URLSearchParams(query === -1 ? "" : rawUrl.slice(query + 1));
}
