// Copyright 2026 the AAI authors. MIT license.
/**
 * The `aai login` handshake code, when this tab was opened by the CLI.
 *
 * The code moves OUT of the URL and into per-tab sessionStorage as soon as
 * the page loads: the GitHub OAuth round trip is a same-tab navigation, so
 * sessionStorage carries the code through sign-in WITHOUT it riding the
 * OAuth redirect chain (`redirectTo` → Supabase → GitHub → back), where it
 * would land in third-party redirect URLs and request logs. The code is
 * one-shot and useless until approved, but a credential-adjacent secret has
 * no business on someone else's wire.
 */

/**
 * The server's link-code grammar (studio-schemas.ts) — a mangled link
 * renders the normal studio rather than an approval gate that can only
 * fail.
 */
const CLI_LINK_RE = /^[\w-]{32,128}$/;

const CLI_LINK_STORAGE = "aai-studio-cli-link";

/**
 * Read the link code: from `?cli-link=<code>` on a fresh CLI-opened tab —
 * stashing it in sessionStorage and stripping the URL — or from the stash
 * when the OAuth redirect lands back here with a bare URL.
 */
export function consumeCliLinkCode(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("cli-link");
  if (fromUrl && CLI_LINK_RE.test(fromUrl)) {
    try {
      sessionStorage.setItem(CLI_LINK_STORAGE, fromUrl);
      url.searchParams.delete("cli-link");
      history.replaceState(history.state, "", url);
    } catch {
      // Storage unavailable (Safari private mode, storage blocked by
      // policy) — leave the param in place so the flow still works; the
      // code rides the OAuth redirect as it did before the stash existed.
    }
    return fromUrl;
  }
  try {
    const stored = sessionStorage.getItem(CLI_LINK_STORAGE);
    return stored && CLI_LINK_RE.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Approval handled or dismissed: drop the stash and any surviving param. */
export function clearCliLinkCode(): void {
  try {
    sessionStorage.removeItem(CLI_LINK_STORAGE);
  } catch {
    // Storage unavailable — nothing was stashed.
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has("cli-link")) {
    url.searchParams.delete("cli-link");
    history.replaceState(history.state, "", url);
  }
}

/**
 * The confirmation the approval gate shows. Re-exported rather than derived
 * here: the terminal that ran `aai login` must print the SAME value, so the
 * derivation is a shared contract (`@alexkroman1/aai/utils`), not a copy each
 * end keeps in step with the other.
 */
export { linkConfirmationCode } from "@alexkroman1/aai/internal";
