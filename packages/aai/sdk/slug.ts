// Copyright 2026 the AAI authors. MIT license.
/**
 * Platform slug contract — what a deployed agent's name (its URL slug) may
 * look like, and which names the platform reserves. Use these to validate or
 * generate a slug before deploying.
 *
 * One definition, shared by the deploy client (aai-cli) and the deploy
 * server (aai-server, which validates slugs at every HTTP/WebSocket boundary
 * and derives its route patterns from the regex). Both used to carry
 * hand-synced copies; keep this module dependency-free so the CLI can load
 * it on every invocation without pulling zod.
 */

/** Slug shape accepted by the platform: lowercase letters, digits, `-`, `_` (2–64 chars). */
export const VALID_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/;

/** Longest slug `VALID_SLUG_RE` accepts — for callers that truncate to fit. */
export const MAX_SLUG_LENGTH = 64;

/**
 * Slugs that collide with top-level platform routes and can never be claimed
 * by an agent. `/studio` is the browser coding-agent UI's API namespace;
 * `/studio-assets` serves its client build; `/health` and `/metrics` are the
 * platform health check and Prometheus endpoint; `POST /deploy` is the
 * top-level deploy route (an agent named `deploy` could never be deployed to
 * by slug, and its page would shadow the redirect).
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "studio",
  "studio-assets",
  "health",
  "metrics",
  "deploy",
]);

/**
 * Suffix the studio's auto-preview deploys own (`<project>-preview`).
 *
 * Part of the slug CONTRACT rather than any one package's detail, because
 * three independent things key off it and must not drift: the deploy
 * boundary rejects the suffix for non-preview callers, the hourly
 * orphan-preview sweep reaps agents carrying it, and the CLI refuses to
 * derive a project name that ends in it. An agent that claims this suffix
 * without a workspace referencing it is deleted on a schedule, so a
 * disagreement between those three is silent data loss.
 */
export const PREVIEW_SLUG_SUFFIX = "-preview";
