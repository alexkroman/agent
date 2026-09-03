// Copyright 2026 the AAI authors. MIT license.
/**
 * What the install round trip ESTABLISHED — the decision behind
 * `GET /studio/github/callback`, with none of the redirecting.
 *
 * Split from studio-github-routes.ts for the reason `pushToGithub` is: the
 * route decides how to answer a navigating browser, and this decides what the
 * browser's arrival proved. Both halves are worth reading on their own, and
 * only this one is worth reading twice.
 *
 * **The callback cannot authenticate its caller** (studio-github-state.ts has
 * the argument), so everything that makes it safe is here: the signed `state`
 * has already said WHO is asking, and what follows establishes WHAT they may
 * attach. Nothing in this module trusts a redirect parameter on its own.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import { createLogger } from "aai-server/logger";
import type { SecretStore } from "aai-server/secret-store";
import { resolveInstallation } from "./studio-github-client.ts";
import type { GithubAppConfig } from "./studio-github-config.ts";
import { writeGithubLink } from "./studio-github-link.ts";
import {
  exchangeUserCode,
  listUserInstallations,
  resolveUserInstallation,
  userControlsInstallation,
} from "./studio-github-user.ts";

const log = createLogger("studio.github");

/**
 * Which installation this callback may link, given what the redirect carried
 * and what the user actually administers.
 *
 * Two questions in one pass, because both are answered by the same list and
 * neither is safe without it:
 *
 * - **Entitlement**, when the redirect names an id. The signed `state` proves
 *   WHO is asking and `resolveInstallation` proves the id is real; neither
 *   proves the asker is entitled to it — and `installation_id` is a small
 *   integer whose success is distinguishable from its failure, so it is
 *   enumerable. Without this check any studio user could attach somebody
 *   else's installation and force-push to every repository in it.
 * - **Resolution**, when it does not. GitHub sends `installation_id` only when
 *   the App was installed during this round trip, so a user who already had it
 *   installed arrives with a `code` and nothing else.
 *
 * `"install"` is the third answer, distinct from a refusal: the user
 * authorized us and holds no installation, so the next step is the install
 * page rather than an error. A missing or unexchangeable `code` stays a
 * refusal — nothing about the caller has been established.
 */
type InstallationDecision = { kind: "link"; installationId: number } | "refuse" | "install";

async function decideInstallation(
  config: GithubAppConfig,
  code: string,
  requested: number | undefined,
  fetchFn?: typeof globalThis.fetch,
): Promise<InstallationDecision> {
  if (!code) return "refuse";
  const userToken = await exchangeUserCode(config, code, fetchFn);
  if (!userToken) return "refuse";
  const installations = await listUserInstallations(userToken, fetchFn);
  if (requested !== undefined) {
    return userControlsInstallation(installations, requested)
      ? { kind: "link", installationId: requested }
      : "refuse";
  }
  const resolved = resolveUserInstallation(installations);
  return resolved === undefined ? "install" : { kind: "link", installationId: resolved };
}

/**
 * The four things that can happen to an install callback, leaving the route to
 * do nothing but turn each into a redirect.
 *
 * `"failed"` covers both an installation GitHub does not know and any thrown
 * GitHub error: the id resolved to no account, so there is nothing to record,
 * and the user's recovery is to start again either way.
 */
export type ConnectOutcome = "connected" | "unverified" | "install" | "failed";

/**
 * The redirect's `installation_id` as a usable number, `undefined` when it
 * names none, or `null` when it names something that could never be one.
 *
 * Absence and nonsense are different answers now, where a single check
 * conflated them: absence is the COMMON case (GitHub sends the id only when
 * the App was installed during this round trip) and is resolved from the user
 * token, while a value that cannot be an id is a broken redirect. An EMPTY one
 * reads as absent — `Number("")` is 0, so testing the string first is what
 * keeps that from failing the flow.
 */
function parseInstallationId(raw: string | undefined): number | undefined | null {
  if (!raw) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Everything the callback knows, as the arguments to one decision. */
export type CompleteConnectOptions = {
  config: GithubAppConfig;
  secrets: SecretStore;
  /** The studio user the signed `state` named — never a request field. */
  uid: string;
  code: string;
  /** Exactly as the redirect carried it — see {@link parseInstallationId}. */
  rawInstallationId: string | undefined;
  /** Test seam — never set outside tests. */
  fetchFn?: typeof globalThis.fetch | undefined;
};

/**
 * Establish the account's GitHub link, and report which of the four outcomes
 * that was.
 *
 * Throws only what GitHub throws: the caller turns any of it into `"failed"`,
 * because a link that could not be written and a link that must not be are the
 * same instruction to the user.
 */
export async function completeGithubConnect(opts: CompleteConnectOptions): Promise<ConnectOutcome> {
  const { config, uid, code, fetchFn } = opts;
  const requested = parseInstallationId(opts.rawInstallationId);
  if (requested === null) return "failed";
  const decision = await decideInstallation(config, code, requested, fetchFn);
  if (decision === "refuse") {
    log.warn("github install callback refused an unverified installation", {
      uid,
      ...omitUndefined({ installationId: requested }),
    });
    return "unverified";
  }
  if (decision === "install") return "install";

  const { installationId } = decision;
  // Only now: the id names a real installation of this App, and the person
  // finishing the flow administers it.
  const account = await resolveInstallation(config, installationId, omitUndefined({ fetchFn }));
  if (!account) return "failed";
  await writeGithubLink(opts.secrets, uid, {
    installationId,
    account: account.account,
    accountType: account.accountType,
    connectedAt: Date.now(),
  });
  return "connected";
}
