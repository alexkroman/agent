// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio routes' rate-limit gate: resolve the limiters, and turn a
 * refusal into the 429 the client expects.
 *
 * Split from studio-routes.ts, which is a route table — this is the one piece
 * of it that is policy rather than routing, and it is shared by both limited
 * routes (`POST /projects` and `POST /projects/:project/session`).
 *
 * **Each route is metered on TWO keys, and the second one is the point.** The
 * scope key is derived from the caller's bearer, so for an unauthenticated
 * caller it was a value they picked: one character's difference bought a
 * fresh window, which made both limits decorative against the traffic they
 * exist to stop. The client-IP key does not move when the bearer does. Both
 * are checked, either can refuse, and the scope key is checked FIRST so a
 * legitimate caller's own limit is what they see when they hit one.
 */

import { clientIp } from "aai-server/client-ip";
import {
  CHAT_IP_RATE_LIMIT,
  CHAT_RATE_LIMIT,
  createRateLimiter,
  GITHUB_SYNC_IP_RATE_LIMIT,
  GITHUB_SYNC_RATE_LIMIT,
  PREVIEW_WAKE_IP_RATE_LIMIT,
  PREVIEW_WAKE_RATE_LIMIT,
  PROJECT_CREATE_IP_RATE_LIMIT,
  PROJECT_CREATE_RATE_LIMIT,
  type RateLimiter,
  type StudioRateLimiters,
} from "./studio-rate-limit.ts";

/** Null when the request may proceed, else the 429 to return as-is. */
export type RefuseFn = (scope: string, req: Request) => Promise<Response | null>;

/**
 * One gate per limited route. The limiters themselves stay private: every
 * caller only ever asked "may this scope proceed on this route", and handing
 * out the pair meant each route re-supplying the limiter that its own name
 * already determines.
 */
export type RouteLimits = {
  chat: RefuseFn;
  projectCreate: RefuseFn;
  previewWake: RefuseFn;
  githubSync: RefuseFn;
};

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Rate limit exceeded — try again later" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

/**
 * Per-scope and per-IP fixed-window limits (see studio-rate-limit.ts). The
 * LLM runs on the caller's own key, so these no longer guard a
 * platform-billed proxy — they still bound sandbox spawns and build work.
 * Injected in production (Postgres-backed, shared across replicas); the
 * in-memory defaults cover dev and tests.
 */
export function createRouteLimits(injected?: StudioRateLimiters): RouteLimits {
  const refuse =
    (byScope: RateLimiter, byIp: RateLimiter): RefuseFn =>
    async (scope, req) => {
      const scoped = await byScope.check(scope);
      if (!scoped.ok) return tooMany(scoped.retryAfterSeconds);
      const perIp = await byIp.check(clientIp(req));
      if (!perIp.ok) return tooMany(perIp.retryAfterSeconds);
      return null;
    };
  return {
    chat: refuse(
      injected?.chat ?? createRateLimiter(CHAT_RATE_LIMIT),
      injected?.chatIp ?? createRateLimiter(CHAT_IP_RATE_LIMIT),
    ),
    projectCreate: refuse(
      injected?.projectCreate ?? createRateLimiter(PROJECT_CREATE_RATE_LIMIT),
      injected?.projectCreateIp ?? createRateLimiter(PROJECT_CREATE_IP_RATE_LIMIT),
    ),
    previewWake: refuse(
      injected?.previewWake ?? createRateLimiter(PREVIEW_WAKE_RATE_LIMIT),
      injected?.previewWakeIp ?? createRateLimiter(PREVIEW_WAKE_IP_RATE_LIMIT),
    ),
    githubSync: refuse(
      injected?.githubSync ?? createRateLimiter(GITHUB_SYNC_RATE_LIMIT),
      injected?.githubSyncIp ?? createRateLimiter(GITHUB_SYNC_IP_RATE_LIMIT),
    ),
  };
}
