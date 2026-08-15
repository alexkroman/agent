// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's rate-limit POLICY — which routes are metered, and how hard.
 *
 * The mechanism moved to `aai-server/rate-limit.ts` when the agent surface
 * needed it too (`POST /deploy` had no limiter at all, and `aai-server`
 * cannot import from this package). What stays here is the part that is a
 * judgement about the studio: the two windows, and the pair the routes take.
 *
 * Both are keyed by the caller's `studioScope`. That was the ONLY key until
 * an audit pointed out what it is derived from — for a raw-key caller, a hash
 * of the bearer they chose — so an unauthenticated caller minted a fresh
 * window per request by changing one character. Two things answer that now
 * and they are complementary: raw bearers are verified against AssemblyAI
 * (`aai-server/api-key-verify.ts`), which makes a scope cost an account; and
 * the routes additionally meter by client IP (`studio-route-limits.ts`),
 * which bounds the damage before the account is spent.
 */

import { CLIENT_IP_RATE_LIMIT_WINDOW_MS, type RateLimiter } from "aai-server/rate-limit";

/** `POST /studio/projects/:project/session` — each request can spawn a Modal sandbox. */
export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 5 * 60_000 } as const;
/** `POST /studio/projects` — each request writes a new workspace document. */
export const PROJECT_CREATE_RATE_LIMIT = { limit: 60, windowMs: 60 * 60_000 } as const;
/**
 * `POST /studio/projects/:project/preview/wake` — a workspace read plus a
 * broker call that can spawn a sandbox.
 *
 * It ran unmetered for a while, justified by the per-project throttle in the
 * route. That throttle is a fixed-size `TtlCache` (an LRU), so a caller
 * cycling more distinct project names than it holds evicts entries faster than
 * they expire and every request is a fresh one — the exact traffic a throttle
 * cannot bound and a limiter can. Generous against the honest client, which
 * sends one per missing preview.
 */
export const PREVIEW_WAKE_RATE_LIMIT = { limit: 60, windowMs: 5 * 60_000 } as const;

/**
 * The same two routes, metered by CLIENT IP instead of scope.
 *
 * Deliberately looser than the per-scope limits and not a substitute for
 * them: one IP is legitimately many accounts (an office, a CI runner, a
 * mobile carrier NAT), so this is sized to stop a single host enumerating
 * scopes, not to be the primary meter. It is the limit that still holds when
 * the scope key is worthless — which is exactly the state an attacker
 * arranges by rotating bearers.
 */
export const CHAT_IP_RATE_LIMIT = { limit: 90, windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS } as const;
export const PROJECT_CREATE_IP_RATE_LIMIT = {
  limit: 120,
  windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS,
} as const;
export const PREVIEW_WAKE_IP_RATE_LIMIT = {
  limit: 180,
  windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS,
} as const;

/** The studio's limiters, injectable per app. */
export type StudioRateLimiters = {
  chat: RateLimiter;
  projectCreate: RateLimiter;
  previewWake?: RateLimiter;
  /** Per-IP companions to the three above. */
  chatIp?: RateLimiter;
  projectCreateIp?: RateLimiter;
  previewWakeIp?: RateLimiter;
};

export type { RateLimiter, RateLimitVerdict } from "aai-server/rate-limit";
export { createPgRateLimiter, createRateLimiter } from "aai-server/rate-limit";
