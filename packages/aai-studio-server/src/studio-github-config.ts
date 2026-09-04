// Copyright 2026 the AAI authors. MIT license.
/**
 * The studio's GitHub App identity — the one piece of "Sync to GitHub" that
 * is HOST configuration rather than per-user state.
 *
 * A GitHub App, deliberately, and not the GitHub OAuth the studio already
 * signs in with. Supabase Auth stays the identity layer (`supabase-auth.ts`);
 * this is authorization to write to repositories, and the two are different
 * questions with different blast radii:
 *
 * - **Scope is not paid by everyone.** Reusing the sign-in would mean adding
 *   `repo` to `signInWithOAuth` — full read/write over every repository the
 *   user can reach, demanded at the login screen, from every user, including
 *   the ones who never sync anything. An App is installed per REPOSITORY, by
 *   the user, when they first ask to sync.
 * - **Supabase does not keep the provider token.** `session.provider_token` is
 *   handed over once at sign-in and never refreshed, so it dies at the next
 *   token refresh and syncing would demand a re-login at unpredictable
 *   moments. An installation token is minted server-side, on demand, from the
 *   App's own key and the recorded installation id — nothing user-held expires
 *   underneath it.
 * - **A revoked install is an immediate, visible stop.** Uninstalling the App
 *   is a control the user has on GitHub's side; a leaked OAuth token is not.
 *
 * Absent configuration disables the feature rather than failing a boot: a
 * self-hosted platform (and every test) runs with no GitHub App at all, and
 * `GET /studio/github` answers `configured: false` so the client renders
 * nothing instead of a button that cannot work.
 */

/** What the platform needs to act as its GitHub App. */
export type GithubAppConfig = {
  /** Numeric App id, as GitHub issues it — the JWT's `iss`. */
  appId: string;
  /** The App's RSA private key, PEM-encoded. */
  privateKey: string;
  /**
   * The App's URL slug — `github.com/apps/<slug>` — which is what the install
   * redirect is built from. It is NOT derivable from the app id, and getting
   * it wrong sends the user to a 404 on github.com rather than to an error we
   * could report, so it is required rather than guessed.
   */
  slug: string;
  /**
   * The App's OAuth client credentials, used for ONE thing: proving at the
   * install callback that the person finishing the flow actually controls the
   * installation they are attaching (studio-github-user.ts).
   *
   * Required, like the other three, and for a sharper reason — without them
   * the callback cannot verify entitlement, and an unverified callback accepts
   * any `installation_id`, which is an enumerable integer. So a deployment
   * missing them is not a degraded feature, it is an open one; absent, the
   * whole App reads as unconfigured.
   */
  clientId: string;
  clientSecret: string;
};

/**
 * A PEM re-wrapped from its own header, body and footer — the one repair that
 * survives a key pasted into a single-line field.
 *
 * **The space-collapsed shape is the one that gets past a header test.** The
 * production GitHub App key arrived with 32 spaces and zero newlines: every
 * line break had become a single space, so `includes("-----BEGIN")` was true,
 * the value was returned unchanged, and OpenSSL rejected it with
 * `DECODER routines::unsupported` at the last step of the install callback —
 * after GitHub had already authorized the user, which is why it reads as
 * "GitHub could not complete the connection" rather than as our
 * misconfiguration.
 *
 * The repair has to be STRUCTURAL rather than a whitespace substitution: the
 * label legitimately contains spaces, so replacing them with newlines shatters
 * `-----BEGIN RSA PRIVATE KEY-----` into four lines. Base64 contains none, so
 * stripping all whitespace from the body between the two markers is lossless.
 *
 * Deterministic and idempotent, both load-bearing. This value is also the HMAC
 * key behind every install `state` (studio-github-state.ts), so it must be a
 * function of the key alone — two replicas that disagree by a newline are a
 * fleet whose halves reject each other's callbacks. Re-wrapping at 64 is what
 * PEM emitters use, so an intact key passes through byte-identical.
 *
 * A value that is not a delimited PEM is returned untouched: the honest report
 * for that is OpenSSL's, at the point of use.
 */
function rewrapPem(pem: string): string {
  const match = /^(-----BEGIN [A-Z0-9 ]+-----)([\s\S]*)(-----END [A-Z0-9 ]+-----)$/.exec(pem);
  if (!match) return pem;
  const [, header, body, footer] = match;
  const base64 = (body ?? "").replace(/\s+/g, "");
  if (!base64) return pem;
  return [header, ...(base64.match(/.{1,64}/g) ?? []), footer].join("\n");
}

/**
 * PEM as a value that survived an environment variable.
 *
 * A private key is multi-line and environment variables in practice are not,
 * so the same key reaches us in FOUR shapes depending on who set it: intact
 * (a `.env` file with real newlines, or Modal's secret store), with the
 * newlines backslash-escaped (every shell `export`, and most CI secret UIs),
 * with the newlines collapsed to SPACES (a paste through a single-line form
 * field — see {@link rewrapPem}), or base64 (the workaround people reach for
 * once the escaping has bitten them). All four are the same key and none of
 * them is a mistake worth failing a boot over — but only the first one signs a
 * JWT, and the failure from the other three is
 * `error:1E08010C:DECODER routines::unsupported` at the first sync, hours
 * later, nowhere near the misconfiguration.
 */
function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  // Escaped newlines first: the result still has to contain a PEM header, so
  // an unescape that was not needed cannot turn a valid key into an invalid
  // one — `\n` never appears in base64 or in a real PEM body.
  const unescaped = trimmed.includes("\\n") ? trimmed.replaceAll("\\n", "\n") : trimmed;
  // Trimmed AGAIN after each decode, and re-wrapped, so all four spellings of
  // one key produce the byte-identical result. Both decodes restore the PEM's
  // trailing newline that the first trim removed, and this value is hashed —
  // it is the HMAC key behind every install `state` (studio-github-state.ts) —
  // so a key that differs by a newline between two deployments of the same App
  // is a fleet whose halves reject each other's states.
  if (unescaped.includes("-----BEGIN")) return rewrapPem(unescaped.trim());
  // Not a PEM in any spelling, so the remaining shape is base64 OF one. A
  // decode that yields something without a header is returned unchanged: it
  // is not a key we recognize, and the honest report for that is OpenSSL's,
  // at the point of use, rather than a truncated guess from here.
  const decoded = Buffer.from(unescaped, "base64").toString("utf8");
  return decoded.includes("-----BEGIN") ? rewrapPem(decoded.trim()) : unescaped;
}

/**
 * Read the App from the environment, or `undefined` when it is not configured.
 *
 * ALL of them or none. A half-configured App is the state where the install
 * link works and every sync fails — and, for the OAuth pair, the worse state
 * where the callback cannot check entitlement at all. So a missing variable
 * reads as "not configured" and the client never offers the button.
 */
export function createGithubAppConfig(env: NodeJS.ProcessEnv): GithubAppConfig | undefined {
  const {
    GITHUB_APP_ID: appId,
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_APP_SLUG: slug,
    GITHUB_APP_CLIENT_ID: clientId,
    GITHUB_APP_CLIENT_SECRET: clientSecret,
  } = env;
  if (!(appId && privateKey && slug && clientId && clientSecret)) return undefined;
  return { appId, privateKey: normalizePrivateKey(privateKey), slug, clientId, clientSecret };
}

/**
 * The App's install page — where a user picks which repositories it may write.
 *
 * `installations/new` rather than an OAuth authorize URL: this flow's product
 * is an INSTALLATION on chosen repositories. The one place that URL is spelled,
 * because it is NOT derivable from the app id and getting it wrong sends the
 * user to a 404 on github.com rather than to an error we could report — a
 * second copy would fix the connect flow and leave the settings pane's "Add or
 * remove repositories" link pointing at that 404.
 */
export function githubInstallPageUrl(config: GithubAppConfig): string {
  return `https://github.com/apps/${config.slug}/installations/new`;
}

/**
 * The same page, carrying the signed `state` GitHub echoes back to the
 * callback — where a user who has NOT installed the App yet picks their
 * repositories.
 *
 * Deliberately no longer the connect button's destination; see
 * {@link githubAuthorizeUrl}. It is where the callback bounces a user whose
 * account holds no installation of this App, which is the one case that really
 * does need this page.
 */
export function githubInstallUrl(config: GithubAppConfig, state: string): string {
  const url = new URL(githubInstallPageUrl(config));
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Where the Connect button sends the tab — user authorization, NOT the install
 * page.
 *
 * **`installations/new` is a dead end for an App that is already installed**,
 * and that is GitHub's documented behaviour rather than an edge case: the
 * second visit shows the installation's "update permissions" screen and never
 * fires the post-install redirect, so the callback never runs, no link is
 * written, and the studio's button stays "Connect GitHub" forever. Anyone who
 * has installed the App once — a first attempt that was interrupted, another
 * studio account, or simply installing it from GitHub first — lands there
 * permanently, with the App visibly installed and the studio insisting it is
 * not. A popup would not help: what the popup would be sitting on is a GitHub
 * settings page with nothing to report back.
 *
 * `/login/oauth/authorize` always ends at the App's callback URL with a
 * `code`, installed or not — so the round trip completes either way, and the
 * callback resolves WHICH installation from the user token rather than from a
 * redirect parameter GitHub only sometimes sends (studio-github-user.ts).
 * When the App is not installed at all, the authorize screen offers to install
 * it; when the user declines, the callback finds no installation and bounces
 * them to {@link githubInstallUrl}.
 *
 * No `redirect_uri`: GitHub sends a GitHub App's authorization to the FIRST
 * callback URL registered on the App whatever we pass, so naming one here
 * would be a value that reads as authoritative and decides nothing.
 */
export function githubAuthorizeUrl(config: GithubAppConfig, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("state", state);
  return url.toString();
}
