// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio routes' rate-limit gate: resolve the two limiters, and turn a
 * refusal into the 429 the client expects.
 *
 * Split from studio-routes.ts, which is a route table — this is the one piece
 * of it that is policy rather than routing, and it is shared by both limited
 * routes (`POST /projects` and `POST /projects/:project/session`).
 */

import {
  CHAT_RATE_LIMIT,
  createRateLimiter,
  PROJECT_CREATE_RATE_LIMIT,
  type RateLimiter,
  type StudioRateLimiters,
} from "./studio-rate-limit.ts";

/** A limiter pair plus the shared refusal, ready for the route table. */
export type RouteLimits = {
  chat: RateLimiter;
  projectCreate: RateLimiter;
  /** Null when the request may proceed, else the 429 to return as-is. */
  refuse(scope: string, limiter: RateLimiter): Promise<Response | null>;
};

/**
 * Per-scope fixed-window limits (see studio-rate-limit.ts). The LLM runs on
 * the caller's own key, so these no longer guard a platform-billed proxy —
 * they still bound sandbox spawns and build work per caller. Injected in
 * production (Postgres-backed, shared across replicas); the in-memory default
 * covers dev and tests.
 */
export function createRouteLimits(injected?: StudioRateLimiters): RouteLimits {
  return {
    chat: injected?.chat ?? createRateLimiter(CHAT_RATE_LIMIT),
    projectCreate: injected?.projectCreate ?? createRateLimiter(PROJECT_CREATE_RATE_LIMIT),
    async refuse(scope, limiter) {
      const verdict = await limiter.check(scope);
      if (verdict.ok) return null;
      return Response.json(
        { error: "Rate limit exceeded — try again later" },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
      );
    },
  };
}
