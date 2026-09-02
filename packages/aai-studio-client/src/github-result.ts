// Copyright 2026 the AAI authors. MIT license.
/**
 * The `?github=` result the install callback lands the browser with.
 *
 * The callback is a top-level navigation, so its only channel back into the
 * app is the URL — and the URL is where it must not STAY: the studio pushes
 * and pops history as the user moves between projects, so a surviving
 * parameter would re-announce a connection every time they navigated back to
 * this project, hours later. It is read once and stripped, the same posture
 * `cli-link.ts` takes for a very different reason (there, to keep a secret out
 * of a redirect chain; here, to keep a one-shot report from becoming state).
 *
 * Unrecognized values are dropped rather than shown. The parameter is
 * user-editable, and the card renders our own sentence for each outcome — so
 * an unknown one has no sentence and reflecting it would be a way to put
 * arbitrary text on the page.
 */

/**
 * What the callback can report. See `studio-github-routes.ts`'s `back()`.
 *
 * The type is DERIVED from the list rather than spelled beside it: two copies
 * means adding an outcome type-checks while the runtime guard below silently
 * drops it.
 */
const RESULTS = ["connected", "failed", "expired", "unverified", "unconfigured"] as const;

export type GithubConnectResult = (typeof RESULTS)[number];

/**
 * Is a GitHub connect result waiting in the URL? Peeks, consuming nothing.
 *
 * The install callback is a full NAVIGATION, so the tab selection resets — and
 * the card that renders the result only mounts on the Settings pane. Without
 * this the report was never shown at all: `?github=failed` produced no visible
 * error, and the parameter sat in the URL to be consumed later out of context.
 * `ProjectView` uses it to open on Settings, where the card then consumes it.
 */
export function hasGithubResult(): boolean {
  return new URL(window.location.href).searchParams.has("github");
}

/**
 * Read `?github=` and remove it from the URL, or `null` when it names nothing.
 *
 * `replaceState` rather than `pushState`: the parameter is not a place the
 * user navigated to, and leaving it in the back stack would make Back
 * re-announce the result.
 */
export function consumeGithubResult(): GithubConnectResult | null {
  const url = new URL(window.location.href);
  const raw = url.searchParams.get("github");
  if (raw === null) return null;
  url.searchParams.delete("github");
  history.replaceState(history.state, "", url);
  return RESULTS.includes(raw as GithubConnectResult) ? (raw as GithubConnectResult) : null;
}

/** What to tell the user about a completed (or failed) connect round trip. */
export function githubResultText(result: GithubConnectResult): string {
  switch (result) {
    case "connected":
      return "GitHub connected.";
    case "expired":
      return "That connection link had expired — try connecting again.";
    case "unverified":
      // The entitlement check refused: the installation is not one this GitHub
      // account administers, or the authorization did not complete. Worded as
      // the honest instruction rather than an accusation — the overwhelmingly
      // common cause is an interrupted flow, not an attack.
      return "GitHub could not confirm you administer that installation — connect again from the account that owns it.";
    case "unconfigured":
      return "GitHub sync is not configured on this server.";
    default:
      return "GitHub could not complete the connection — try again.";
  }
}
