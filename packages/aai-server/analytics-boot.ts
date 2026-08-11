// Copyright 2026 the AAI authors. MIT license.
/**
 * What a deployed agent's guest is told about shipping analytics, as boot env.
 *
 * This is one FEATURE'S half of the guest boot contract. The core half —
 * mode, token, port, bundle location, env path — is `agentBootEnv` in
 * warm-harness.ts, and it takes an opaque `bootEnv` for everything like this
 * rather than a typed field per feature.
 *
 * That split is the point. Key names have to agree with exactly one reader
 * (`analyticsShipperFromEnv` in aai-guest), and the way they drift is by
 * being spelled in a builder that knows nothing about the feature. Here they
 * sit beside the token they travel with; the transport layers between this
 * and the sandbox carry a `Record<string, string>` and never name a key at
 * all.
 */

/**
 * A guest's analytics destination: an absolute ingest URL on the platform's
 * public origin, a token authorizing exactly one slug, that slug, and the
 * deploy generation to stamp on every row.
 *
 * It carries its own slug even though the spawn objects it rides on have one:
 * the token and the slug it authorizes are minted together (see
 * `analyticsTarget` in sandbox-resolve.ts), and splitting the pair so the env
 * builder re-derives the slug from somewhere else would put its two halves in
 * two places with nothing reconciling them.
 */
export type GuestAnalyticsTarget = {
  url: string;
  token: string;
  slug: string;
  version: number;
};

/**
 * The guest env for one target. All four keys or none: a partial set reads to
 * the guest as "not configured", which is the right failure — a guest that
 * buffers rows it can never ship is worse than one that records none.
 */
export function analyticsBootEnv(target: GuestAnalyticsTarget): Record<string, string> {
  return {
    AAI_ANALYTICS_URL: target.url,
    AAI_ANALYTICS_TOKEN: target.token,
    AAI_ANALYTICS_SLUG: target.slug,
    AAI_ANALYTICS_VERSION: String(target.version),
  };
}
