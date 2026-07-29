// Copyright 2026 the AAI authors. MIT license.
/**
 * Per-scope rate limiting for the studio's expensive routes.
 *
 * Studio auth accepts any non-empty bearer key (workspace scoping is all it
 * needs), so without a cap `POST /studio/chat` is an unmetered LLM proxy
 * running on platform-owned provider keys, and project creation is unmetered
 * storage growth. A small fixed-window limiter keyed by the caller's
 * `studioScope` bounds both.
 *
 * The window map is a `TtlCache` (quick-lru with the window as max-age), so
 * attacker-chosen scopes cannot grow it without bound: stale windows expire
 * on read and the LRU cap evicts beyond `maxKeys`.
 */

import { TtlCache } from "../_ttl-cache.ts";

/** `POST /studio/chat` — each request is an LLM turn on platform keys. */
export const CHAT_RATE_LIMIT = { limit: 30, windowMs: 5 * 60_000 } as const;
/** `POST /studio/projects` — each request writes a new workspace document. */
export const PROJECT_CREATE_RATE_LIMIT = { limit: 60, windowMs: 60 * 60_000 } as const;

/** LRU cap on tracked scopes per limiter. */
const MAX_TRACKED_KEYS = 10_000;

type Window = { count: number; resetAt: number };

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export type RateLimiter = {
  /** Count one request against `key`; refuse once the window's limit is hit. */
  check(key: string, now?: number): RateLimitVerdict;
};

export function createRateLimiter(options: { limit: number; windowMs: number }): RateLimiter {
  const windows = new TtlCache<Window>(options.windowMs, MAX_TRACKED_KEYS);
  return {
    check(key, now = Date.now()) {
      const entry = windows.get(key);
      // The explicit `resetAt` check (not just the cache TTL) keeps the
      // window correct even when a caller supplies its own clock.
      if (!entry || entry.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + options.windowMs });
        return { ok: true };
      }
      if (entry.count < options.limit) {
        entry.count += 1;
        return { ok: true };
      }
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    },
  };
}
