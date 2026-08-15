// Copyright 2026 the AAI authors. MIT license.
/**
 * Where the platform lives, as far as this page is concerned.
 *
 * The studio and the agent surface are ONE origin by construction (see "One
 * public origin" in packages/aai-server/CLAUDE.md), so the page's own origin is
 * the platform's and no round trip asks the server for it. That reasoning was
 * written out three times — the top bar's production link, the phone card's
 * webhook URLs, and the workflows card's agent API — each with its own copy of
 * the same comment, which is how three call sites end up disagreeing about
 * whether the origin is derived or configured.
 */

/** The platform's origin: this page's, because they are the same one. */
export function platformOrigin(): string {
  return window.location.origin;
}

/**
 * Absolute URL of a deployed agent. The href works either way, but the *text*
 * is what people copy out or paste to a colleague, so it carries the origin
 * rather than a bare "/slug/".
 */
export function agentUrl(slug: string): string {
  return new URL(`/${slug}/`, platformOrigin()).toString();
}
