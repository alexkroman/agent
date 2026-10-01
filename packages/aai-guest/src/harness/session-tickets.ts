// Copyright 2026 the AAI authors. MIT license.
/**
 * The deployed guest's session gate: `WS /websocket` (and `WS /inbox`, behind
 * the same gate) opens only for a session ticket.
 *
 * Two keys are accepted:
 *
 * - **The platform's**, derived from this sandbox's bearer
 *   (`platformSessionSecret(AAI_GUEST_TOKEN)`). The platform's
 *   `GET /:slug/client-config` broker derives the same key from the same
 *   bearer and mints the default client's ticket with it, so the key is never
 *   delivered at all: the bearer arrives through the exec env as it always did,
 *   and nothing new reaches the agent's env, the bundle or the browser.
 * - **The author's**, when the agent's env sets `AAI_SESSION_SECRET` — tickets
 *   the author's own backend mints after its own login check, exactly as on a
 *   self-hosted server.
 *
 * A platform ticket is always BOUND to one session, so the gate opens that
 * session and no other (`SessionGate.admits` in `aai-runtime`): possession of
 * the ticket, not knowledge of the session id, is what resumes.
 *
 * @module
 */

import {
  createSessionAuth,
  SESSION_SECRET_ENV,
  type SessionAuth,
  type SessionIdentity,
  verifySessionToken,
} from "@alexkroman1/aai-runtime/auth";
import { platformSessionSecret } from "@alexkroman1/aai-runtime/internal";

/** Check one presented ticket against the platform's key, then the author's. */
export function guestTicketVerifier(
  guestToken: string,
  agentEnv: Readonly<Record<string, string>>,
): (token: string) => SessionIdentity | undefined {
  const keys = [platformSessionSecret(guestToken)];
  const authorSecret = agentEnv[SESSION_SECRET_ENV];
  if (authorSecret !== undefined && authorSecret.trim() !== "") keys.push(authorSecret);
  return (token) => {
    for (const secret of keys) {
      const identity = verifySessionToken(token, { secret });
      if (identity !== undefined) return identity;
    }
  };
}

/** The `auth` handle `createRuntimeServer` takes in a deployed guest. */
export function guestSessionAuth(
  guestToken: string,
  agentEnv: Readonly<Record<string, string>>,
): SessionAuth {
  return createSessionAuth({ verify: guestTicketVerifier(guestToken, agentEnv) });
}
