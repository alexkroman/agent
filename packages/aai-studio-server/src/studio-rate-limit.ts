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

import {
  CLIENT_IP_RATE_LIMIT_WINDOW_MS,
  createPgRateLimiter,
  type RateLimiter,
} from "aai-server/rate-limit";
import type { SqlExec } from "aai-server/secret-store";

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
 * `POST /studio/projects/:project/github/sync` — one request is a blob upload
 * PER FILE plus a tree, a commit and a ref write, against a third party that
 * meters us as one App across every tenant. So this window protects GitHub's
 * secondary rate limits (and the App's standing with them) as much as it
 * protects this service, which is why it is the tightest of the four: a human
 * pressing Sync after an edit is nowhere near it, and a client stuck in a
 * retry loop is.
 */
export const GITHUB_SYNC_RATE_LIMIT = { limit: 30, windowMs: 5 * 60_000 } as const;

/**
 * The same routes, metered by CLIENT IP instead of scope.
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
export const GITHUB_SYNC_IP_RATE_LIMIT = {
  limit: 60,
  windowMs: CLIENT_IP_RATE_LIMIT_WINDOW_MS,
} as const;

/**
 * The studio's limiters, injectable per app.
 *
 * EVERY field is optional, because that is what the type is used as: an
 * OVERRIDE map. `createRouteLimits` reads each one as
 * `injected?.x ?? createRateLimiter(DEFAULT)`, and the Postgres factory
 * answers `Required<StudioRateLimiters>` regardless — so a required field
 * only ever taxed a spec into constructing a window it does not exercise.
 */
export type StudioRateLimiters = {
  chat?: RateLimiter;
  projectCreate?: RateLimiter;
  previewWake?: RateLimiter;
  githubSync?: RateLimiter;
  /** Per-IP companions to the four above. */
  chatIp?: RateLimiter;
  projectCreateIp?: RateLimiter;
  previewWakeIp?: RateLimiter;
  githubSyncIp?: RateLimiter;
};

export type { RateLimiter, RateLimitVerdict } from "aai-server/rate-limit";
export { createPgRateLimiter, createRateLimiter } from "aai-server/rate-limit";

/**
 * EVERY studio window, Postgres-backed, from one factory — the shape
 * `createPgAgentRateLimiters` already established on the agent surface, and
 * for the reason that fix is written up in this package's guide.
 *
 * The composition root used to hand-list the windows one at a time, and a
 * window added to this module but not to that list falls through to
 * `createRateLimiter`'s in-memory arm: the limit then multiplies by the
 * replica count (`MAX_CONTAINERS`), so a 30/5min window silently enforces 90
 * and resets on every deploy. Nothing goes red — every spec injects a limiter
 * and so never sees the default — which is exactly how the workflow limiters
 * ran unmetered fleet-wide for months.
 *
 * The return type is `Required<StudioRateLimiters>`, so a window that gains an
 * optional field here is a COMPILE error until this factory answers it, and
 * `studio-rate-limit.test.ts` additionally holds the factory to the windows
 * this module declares.
 */
export function createPgStudioRateLimiters(sql: SqlExec): Required<StudioRateLimiters> {
  const limiter = (name: string, window: { limit: number; windowMs: number }): RateLimiter =>
    createPgRateLimiter(sql, { name, ...window });
  return {
    chat: limiter("studio-chat", CHAT_RATE_LIMIT),
    projectCreate: limiter("studio-project-create", PROJECT_CREATE_RATE_LIMIT),
    previewWake: limiter("studio-preview-wake", PREVIEW_WAKE_RATE_LIMIT),
    githubSync: limiter("studio-github-sync", GITHUB_SYNC_RATE_LIMIT),
    // The per-IP companions. Postgres-backed for the same reason as the scoped
    // ones and more so: an abuse limit that multiplies by the replica count is
    // a limit of several times what it says.
    chatIp: limiter("studio-chat-ip", CHAT_IP_RATE_LIMIT),
    projectCreateIp: limiter("studio-project-create-ip", PROJECT_CREATE_IP_RATE_LIMIT),
    previewWakeIp: limiter("studio-preview-wake-ip", PREVIEW_WAKE_IP_RATE_LIMIT),
    githubSyncIp: limiter("studio-github-sync-ip", GITHUB_SYNC_IP_RATE_LIMIT),
  };
}
