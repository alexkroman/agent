// Copyright 2026 the AAI authors. MIT license.
/**
 * Which sign-in methods the auth backend really offers, asked of GoTrue itself.
 *
 * Its own module rather than part of `auth.tsx` for the reason that file is
 * excluded from the coverage floors: this is a plain fetch-and-parse with
 * load-bearing fallback semantics — exactly the extracted logic the floors are
 * meant to govern — while the hook next door is supabase-js, an auth-state
 * subscription and an OAuth redirect. Keeping them apart is also what stops a
 * test of THIS from dragging that whole graph into the module registry.
 */

/**
 * Which sign-in methods the auth backend really offers.
 *
 * Two booleans rather than a list of provider names: these are the only two the
 * client can DRIVE (a third provider needs its own `signInWithOAuth` call and its
 * own button), so naming what is offered keeps the screen from advertising a
 * method it cannot complete.
 */
export type SignInMethods = { github: boolean; password: boolean };

/** GitHub-only — what the sign-in screen offered before it asked GoTrue anything. */
export const GITHUB_ONLY: SignInMethods = { github: true, password: false };

/** Neither: `dev` mode has one method of its own, and it is not GoTrue's. */
export const NO_PROVIDERS: SignInMethods = { github: false, password: false };

/**
 * Per-attempt deadline for the provider read.
 *
 * The same 10s every gating read on this screen carries, and for the same
 * reason: a request issued while the server is restarting or saturated can HANG
 * rather than fail, and a browser fetch has no timeout of its own — so without
 * one the sign-in screen never renders a button at all. Declared here rather
 * than imported from `api.ts` because this read does not go through
 * `fetchJson()`: it is not our server's route, and it carries an `apikey` header
 * instead of a bearer.
 */
const SIGN_IN_METHODS_TIMEOUT_MS = 10_000;

/**
 * Ask GoTrue which providers it has enabled.
 *
 * Unauthenticated and public — it is what every supabase-js client reads to
 * decide the same thing — so the publishable key is the whole credential.
 *
 * **A failed or unparsable read falls back to GitHub-only, never to nothing.**
 * An unknown answer must not remove the method production actually uses: that
 * would turn one flaky read into a studio nobody can sign in to. The mirror-image
 * default (assume everything is on) would offer a button GoTrue answers
 * `provider is not enabled` to, after a round trip through somebody else's site.
 */
export async function readSignInMethods(
  url: string,
  publishableKey: string,
): Promise<SignInMethods> {
  try {
    // A trailing slash on the project URL is legitimate — it comes from the
    // server's own `/studio/auth` payload — and `new URL(relative, base)` drops
    // the last path segment without one, so it is normalized rather than trusted.
    const settings = new URL("auth/v1/settings", url.replace(/\/?$/, "/"));
    const res = await fetch(settings, {
      headers: { apikey: publishableKey },
      signal: AbortSignal.timeout(SIGN_IN_METHODS_TIMEOUT_MS),
    });
    if (!res.ok) return GITHUB_ONLY;
    const body: unknown = await res.json();
    const external = (body as { external?: Record<string, unknown> }).external;
    if (!external) return GITHUB_ONLY;
    // Strict `=== true`, not coerced: GoTrue omits nothing today, and a
    // truthiness check would turn a future non-boolean into an enabled button.
    return { github: external.github === true, password: external.email === true };
  } catch {
    return GITHUB_ONLY;
  }
}
