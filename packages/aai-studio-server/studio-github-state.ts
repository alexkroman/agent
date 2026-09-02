// Copyright 2026 the AAI authors. MIT license.
/**
 * The `state` that carries a studio user across the GitHub install redirect.
 *
 * **The callback is the one studio route that cannot authenticate its
 * caller.** `GET /studio/github/callback` is a top-level browser navigation
 * that GitHub performs — no `Authorization` header, no bearer, nothing
 * `authMw` could resolve — and what it has to decide is which account an
 * installation belongs to. So the answer travels in the redirect itself, and
 * the only thing that makes that safe is a signature: without one, `?state=`
 * is an attacker-supplied user id and the callback is a route for attaching
 * your own GitHub installation to someone else's studio account.
 *
 * Three properties, in the order they matter:
 *
 * - **Signed with a key derived from the App's private key**, so no fourth
 *   environment variable exists to be forgotten (an absent one would have to
 *   fall back to something, and every fallback here is "unsigned"). It is a
 *   derivation rather than the key itself — HMAC and RSA signing must not
 *   share key material — and a `hash` of the PEM is what makes the HMAC key a
 *   fixed 32 bytes regardless of the PEM's shape.
 * - **Short-lived.** The state is a bearer for one linking action, so an `exp`
 *   bounds a captured one. Ten minutes is the width of the install flow
 *   itself: pick repositories, confirm, return.
 * - **Verified in constant time.** A signature compared with `===` leaks its
 *   prefix, and this signature is exactly the thing an attacker would grind.
 *
 * What the signature does NOT cover is a state the user's own browser leaked
 * (an extension, a shared screen) — it is a bearer, like every OAuth `state`.
 * The callback's second check is the backstop: the installation id is
 * resolved against GitHub before it is stored, so the record always names an
 * installation that really exists and the account that really holds it.
 */

import { createHmac, hash } from "node:crypto";
import { safeJsonParse } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { constantTimeEquals } from "aai-server/platform-barrel";
import { z } from "zod";
import type { GithubAppConfig } from "./studio-github-config.ts";

/** How long a minted state may be redeemed for — the width of an install. */
export const INSTALL_STATE_TTL_MS = 10 * 60_000;

/**
 * What the state asserts: whose account this installation joins, and which
 * project the user was on when they asked.
 *
 * `project` rides along so the callback can bounce the browser back to the
 * project the Sync button was pressed on — a linking round trip that lands on
 * the home screen reads as having lost the user's place. It is a hint, never
 * an authorization: nothing about the link is scoped by it.
 */
const InstallStateSchema = z.object({
  uid: z.string().min(1),
  project: z.string().min(1).optional(),
  exp: z.number(),
});

export type InstallState = z.infer<typeof InstallStateSchema>;

/**
 * The HMAC key: a digest of the App's private key, domain-separated so this
 * value can never coincide with another derivation over the same PEM.
 */
function stateKey(config: GithubAppConfig): Buffer {
  return Buffer.from(hash("sha256", `aai-studio-github-state:${config.privateKey}`, "hex"), "hex");
}

function sign(config: GithubAppConfig, payload: string): string {
  return createHmac("sha256", stateKey(config)).update(payload).digest("base64url");
}

/** Mint a state for `uid`, valid for {@link INSTALL_STATE_TTL_MS}. */
export function signInstallState(
  config: GithubAppConfig,
  claims: { uid: string; project?: string | undefined },
  now: number = Date.now(),
): string {
  const state: InstallState = {
    uid: claims.uid,
    ...omitUndefined({ project: claims.project }),
    exp: now + INSTALL_STATE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${payload}.${sign(config, payload)}`;
}

/**
 * The claims a state carries, or `null` for anything that is not a live,
 * correctly-signed one.
 *
 * One `null` for every rejection — malformed, wrongly signed, expired — on
 * purpose: the caller's only action is the same in each case (send the user
 * back through the install link), and distinguishing them in a response would
 * tell whoever is probing which half of a forgery they got right.
 */
export function verifyInstallState(
  config: GithubAppConfig,
  state: string,
  now: number = Date.now(),
): InstallState | null {
  const [payload, signature, ...rest] = state.split(".");
  if (!(payload && signature) || rest.length > 0) return null;
  if (!constantTimeEquals(signature, sign(config, payload))) return null;
  const decoded = safeJsonParse(Buffer.from(payload, "base64url").toString("utf8"));
  const parsed = InstallStateSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return parsed.data.exp > now ? parsed.data : null;
}
