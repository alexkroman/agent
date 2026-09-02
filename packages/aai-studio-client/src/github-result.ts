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

/** What the callback can report. See `studio-github-routes.ts`'s `back()`. */
export type GithubConnectResult = "connected" | "failed" | "expired" | "unconfigured";

const RESULTS: readonly string[] = ["connected", "failed", "expired", "unconfigured"];

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
  return RESULTS.includes(raw) ? (raw as GithubConnectResult) : null;
}

/** What to tell the user about a completed (or failed) connect round trip. */
export function githubResultText(result: GithubConnectResult): string {
  switch (result) {
    case "connected":
      return "GitHub connected.";
    case "expired":
      return "That connection link had expired — try connecting again.";
    case "unconfigured":
      return "GitHub sync is not configured on this server.";
    default:
      return "GitHub could not complete the connection — try again.";
  }
}
