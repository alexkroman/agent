// Copyright 2026 the AAI authors. MIT license.
/**
 * Proof that the person finishing an install actually CONTROLS the
 * installation they are attaching.
 *
 * **This closes a cross-tenant escalation, and the shape of it is worth
 * stating.** The install callback is a plain `GET` anyone can issue, and its
 * signed `state` proves only WHO is asking — a studio user can mint one for
 * themselves at any time. `resolveInstallation` proves the id names a real
 * installation OF THIS APP and says whose it is. Neither answers the question
 * that actually authorizes the write: is the asker entitled to it. Without
 * this module the callback accepted any `installation_id`, and that value is a
 * small integer whose success is distinguishable from its failure — so it is
 * enumerable, and a link to somebody else's installation grants list access
 * plus force-push over every repository in it.
 *
 * GitHub's own answer is a USER access token: the App is configured to
 * "Request user authorization (OAuth) during installation", the callback then
 * carries a `code` alongside `installation_id`, and `GET /user/installations`
 * with the token that code exchanges for lists exactly the installations that
 * user can administer. An attacker cannot obtain a token for a victim, so the
 * intersection is the authorization.
 *
 * The user token is used for this ONE question and then dropped — never
 * stored, never used to reach a repository. Everything the studio actually
 * does runs on the installation token, which is scoped to the repositories the
 * user granted rather than to everything the user can see.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { GithubAppConfig } from "./studio-github-config.ts";

/** Deadline for the two calls here — same budget as every other GitHub call. */
const USER_REQUEST_TIMEOUT_MS = 20_000;

/** Installations one `GET /user/installations` page may report. */
const PAGE_SIZE = 100;
/** Pages to walk. A user who administers more than this is not a real case. */
const MAX_PAGES = 5;

function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(USER_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Exchange the callback's `code` for a user access token, or null.
 *
 * Null for every failure — a used code, a wrong one, a mismatched client
 * secret. The caller's recovery is the same in each case (start the connect
 * flow again), and the callback answers all of them identically.
 */
export async function exchangeUserCode(
  config: GithubAppConfig,
  code: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  if (!(config.clientId && config.clientSecret)) return null;
  const res = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
    signal: deadline(),
  });
  if (!res.ok) return null;
  // GitHub answers 200 with `{ error: ... }` for a bad code, so the status is
  // not the test — the presence of a token is.
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) return null;
  const token = body.access_token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * True when `installationId` is one the token's owner can administer.
 *
 * The whole authorization decision. Any failure reads as FALSE rather than
 * throwing: this gate must fail closed, and "we could not confirm" and "you do
 * not control it" call for the same refusal.
 */
export async function userControlsInstallation(
  userToken: string,
  installationId: number,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `https://api.github.com/user/installations?per_page=${PAGE_SIZE}&page=${page}`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: deadline(),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json().catch(() => null);
    if (!(isRecord(body) && Array.isArray(body.installations))) return false;
    for (const entry of body.installations) {
      if (isRecord(entry) && entry.id === installationId) return true;
    }
    if (body.installations.length < PAGE_SIZE) return false;
  }
  return false;
}
