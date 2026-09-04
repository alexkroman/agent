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
 * GitHub's own answer is a USER access token: the connect flow goes through
 * `/login/oauth/authorize`, so the callback always carries a `code`, and
 * `GET /user/installations` with the token that code exchanges for lists
 * exactly the installations that user can administer. An attacker cannot
 * obtain a token for a victim, so the intersection is the authorization.
 *
 * That list answers a second question as well, and only because the first one
 * made it available: WHICH installation to link when the redirect names none.
 * GitHub sends `installation_id` only when the App was installed during this
 * round trip, so for everyone who already had it installed the list is the
 * sole source of that id.
 *
 * The user token is used for this ONE question and then dropped — never
 * stored, never used to reach a repository. Everything the studio actually
 * does runs on the installation token, which is scoped to the repositories the
 * user granted rather than to everything the user can see.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { deadlineFetch } from "./studio-github-client.ts";
import type { GithubAppConfig } from "./studio-github-config.ts";

/** Installations one `GET /user/installations` page may report. */
const PAGE_SIZE = 100;
/** Pages to walk. A user who administers more than this is not a real case. */
const MAX_PAGES = 5;

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
  const res = await deadlineFetch(fetchFn)("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
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
 * Every installation OF THIS APP the token's owner can administer, newest
 * first.
 *
 * The endpoint is already scoped to the App the token was issued for — it
 * lists "installations of your GitHub App that the authenticated user has
 * explicit permission to access" — so there is nothing to filter by app id,
 * and an entry here is by construction one this platform can act as.
 *
 * **Any failure reads as an EMPTY list rather than throwing.** Both callers
 * fail closed on that: the entitlement check refuses, and the resolver bounces
 * the user to the install page. A thrown error would instead reach the
 * callback's catch and report `failed`, which is the one answer that tells the
 * user nothing about what to do next.
 *
 * Sorted DESCENDING by id, which is creation order — see
 * {@link resolveUserInstallation} for the one decision that reads it.
 */
export async function listUserInstallations(
  userToken: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly number[]> {
  const ids: number[] = [];
  const fetchWithDeadline = deadlineFetch(fetchFn);
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `https://api.github.com/user/installations?per_page=${PAGE_SIZE}&page=${page}`;
    const res = await fetchWithDeadline(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    // A partial read is discarded whole: a page that failed halfway through
    // cannot be told from a user who administers only what we already have,
    // and the difference decides both a refusal and an automatic pick.
    if (!res.ok) return [];
    const body: unknown = await res.json().catch(() => null);
    if (!(isRecord(body) && Array.isArray(body.installations))) return [];
    for (const entry of body.installations) {
      if (isRecord(entry) && typeof entry.id === "number") ids.push(entry.id);
    }
    if (body.installations.length < PAGE_SIZE) break;
  }
  return ids.sort((a, b) => b - a);
}

/**
 * True when `installationId` is one the token's owner can administer.
 *
 * The whole authorization decision, and it is asked ONLY of an id that arrived
 * in the redirect — a resolved one (below) came from this same list and cannot
 * disagree with it.
 */
export function userControlsInstallation(
  installations: readonly number[],
  installationId: number,
): boolean {
  return installations.includes(installationId);
}

/**
 * Which installation to link when the redirect named none.
 *
 * GitHub sends `installation_id` only when the user installed the App during
 * this round trip; an authorization by someone who already had it installed
 * carries a `code` and nothing else, which is the common case now that connect
 * goes through the authorize endpoint (studio-github-config.ts). So the id
 * comes from the user's own list instead — the same list the entitlement check
 * reads, so this can never link something the check would have refused.
 *
 * `undefined` when they administer none: the caller sends them to the install
 * page, which is exactly what that state means.
 *
 * With several, the NEWEST wins (the list is id-descending, and ids increase
 * with creation). One link per account is the model this feature has, so some
 * choice has to be made, and the newest is the one the user most likely just
 * set up. It is never silent — the card names the account it connected and
 * links straight to GitHub's own picker — where refusing would leave a user
 * with the App on two accounts unable to connect at all.
 */
export function resolveUserInstallation(installations: readonly number[]): number | undefined {
  return installations[0];
}
