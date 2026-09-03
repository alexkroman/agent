// Copyright 2026 the AAI authors. MIT license.
/**
 * The client address, for rate-limit keys.
 *
 * **Read the LAST `X-Forwarded-For` entry, not the first.** The header
 * accumulates left to right — each proxy APPENDS the peer it received the
 * request from — so the leftmost entry is whatever the client itself sent and
 * is entirely attacker-controlled, while the rightmost was written by the hop
 * closest to us. `resolvePublicOrigin` reads the FIRST entry from its headers
 * and is right to: it wants what the browser saw. This wants who is calling,
 * which is the opposite end of the same list, and taking the first would hand
 * every attacker a free unlimited supply of rate-limit keys — the precise
 * failure this limiter exists to close, reintroduced through its key.
 *
 * Modal's ASGI proxy adds exactly one hop, so the last entry is the real peer
 * (see modal_deploy.py). `TRUSTED_PROXY_HOPS` exists for a deployment that
 * fronts this with another proxy: set it to the number of hops that append,
 * and that many entries are skipped from the right.
 *
 * With no proxy at all — `aai dev`, local combined runs, the test suites —
 * there is no header and nothing else in a `Request` carries a peer address.
 * That yields {@link UNKNOWN_CLIENT_IP}, one shared bucket. Correct for local
 * dev, and safe rather than open: a shared bucket over-limits, it does not
 * under-limit. It would be wrong for a production deployment behind a proxy
 * that strips the header, which is why the limiters that use it are a second
 * line behind key verification and never the only control.
 */

import { envCount } from "./constants.ts";

/** Key used when no forwarded address is available. Shared, so it over-limits. */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * How many trailing `X-Forwarded-For` entries were appended by proxies we
 * run. 1 = Modal's own. Raise it only for hops that genuinely append.
 */
const TRUSTED_PROXY_HOPS = envCount(process.env.TRUSTED_PROXY_HOPS, 1);

/**
 * The calling address, or {@link UNKNOWN_CLIENT_IP}.
 *
 * Normalized only enough to be a stable map key — never parsed as an address,
 * because it is used for bucketing and nothing else.
 */
export function clientIp(req: Request, hops: number = TRUSTED_PROXY_HOPS): string {
  const header = req.headers.get("x-forwarded-for");
  if (!header) return UNKNOWN_CLIENT_IP;
  const entries = header
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return UNKNOWN_CLIENT_IP;
  // Count `hops` from the right; clamp rather than wrap, so a chain SHORTER
  // than configured falls back to the leftmost entry it does have instead of
  // reading past the array and losing the key entirely.
  const index = Math.max(0, entries.length - hops);
  return entries[index] ?? UNKNOWN_CLIENT_IP;
}
