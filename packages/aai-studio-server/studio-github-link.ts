// Copyright 2026 the AAI authors. MIT license.
/**
 * The record that joins a studio account to a GitHub App installation.
 *
 * One per studio user, in the {@link SecretStore} beside `user-key:<uid>` —
 * the same store, the same key shape, and for the same reason: this is
 * per-account state that must survive a replica and must never reach the
 * browser. It is JSON-serialized and schema-validated on read, exactly like
 * the `cli-link:` grants in studio-account-routes.ts, and for the identical
 * argument — a hand-written two-field guard over a stored document is one
 * edit away from admitting a shape whose `installationId` names somebody
 * else's installation.
 *
 * **An installation id is not itself a credential**, which is why storing it
 * is cheap: acting as an installation additionally requires the App's private
 * key, which never leaves the platform's environment. What the record does
 * carry is an authorization DECISION — "this account may push through that
 * installation" — so it is written only by the callback, only after the
 * installation has been resolved against GitHub, and only for a uid that
 * arrived inside a signed state (studio-github-state.ts).
 *
 * Deliberately keyed by the studio USER and not by the workspace scope. A
 * `aai login`-linked CLI resolves to the same `user:<uid>` scope as the
 * browser (see `apiKeyOwnerSecretName`), but a raw-key caller that no account
 * has claimed does not resolve to a user at all — and such a caller has no
 * business inheriting a browser session's GitHub write access. Keying on the
 * uid means the question "who authorized this" has exactly one answer.
 */

import { safeJsonParse } from "@alexkroman1/aai";
import type { SecretStore } from "aai-server/secret-store";
import { z } from "zod";

/** SecretStore name for one studio user's GitHub App installation link. */
export function githubLinkSecretName(userId: string): string {
  return `github-install:${userId}`;
}

/**
 * The stored link.
 *
 * `account` is denormalized from GitHub at link time so the settings pane can
 * say WHICH GitHub account is connected without a round trip on every render
 * — and so a disconnect prompt can name it. It is display state: every
 * authorization decision reads `installationId`, and a rename on GitHub's side
 * leaves a stale label rather than a wrong permission.
 */
const GithubLinkSchema = z.object({
  installationId: z.number().int().positive(),
  account: z.string().min(1),
  /** `User` or `Organization` — what the account can be asked to do. */
  accountType: z.enum(["User", "Organization"]),
  connectedAt: z.number(),
});

export type GithubLink = z.infer<typeof GithubLinkSchema>;

/**
 * Read the link, or `null` when the account has none — including when the
 * stored document does not parse.
 *
 * A malformed record reads as "not connected" rather than throwing, which is
 * the same posture `parseWorkspace` takes: the recovery a user needs is to
 * connect again, and that is exactly what "not connected" offers them.
 */
export async function readGithubLink(
  secrets: SecretStore,
  userId: string,
): Promise<GithubLink | null> {
  const raw = await secrets.get(githubLinkSecretName(userId));
  if (raw === null) return null;
  const parsed = GithubLinkSchema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : null;
}

/** Record (or replace) the account's link — the callback's only write. */
export async function writeGithubLink(
  secrets: SecretStore,
  userId: string,
  link: GithubLink,
): Promise<void> {
  await secrets.put(githubLinkSecretName(userId), JSON.stringify(link));
}

/**
 * Forget the link.
 *
 * This does NOT uninstall the App — it cannot, and pretending otherwise would
 * be the worse failure: the platform would report the user's GitHub access
 * revoked while the installation still granted it. Disconnecting here stops
 * the studio from using the installation; removing the installation is done
 * on GitHub, and the client says so.
 */
export async function deleteGithubLink(secrets: SecretStore, userId: string): Promise<void> {
  await secrets.delete(githubLinkSecretName(userId));
}
