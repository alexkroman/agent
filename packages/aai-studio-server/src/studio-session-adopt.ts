// Copyright 2026 the AAI authors. MIT license.
/**
 * Adopting a PEER replica's studio sandbox: re-install the session over the
 * guest's HTTP `POST /studio/session-init` instead of the control socket the
 * peer owns.
 *
 * This is the whole point of the session registry. A broker call that lands
 * on a replica with no local entry used to have exactly one move — spawn —
 * which is how one project ended up with a guest per replica. Now it reads
 * the row and comes here.
 *
 * "Adopt" is about the SESSION, not the sandbox: ownership does not move.
 * The peer keeps the socket, the lifecycle, and the guest→host RPCs; this
 * replica only pushes the current workspace in and hands the browser the
 * URL. Nothing here can terminate a guest, which is what keeps two replicas
 * from fighting over one sandbox.
 *
 * The install doubles as the liveness probe. A registry lease says a sandbox
 * *should* be alive; this request proves it. Anything other than a clean 2xx
 * resolves null and the caller takes the cold path — so a stale row costs one
 * failed HTTP round trip, never a dead URL handed to a browser.
 */

import { errorMessage } from "@alexkroman1/aai";
import { GUEST_ROUTES, guestHttpUrl } from "aai-server/guest-routes";
import { createLogger } from "aai-server/logger";
import pTimeout from "p-timeout";
import type { StudioSessionRecord } from "./studio-session-registry.ts";

const log = createLogger("studio.session.adopt");

/**
 * Budget for the peer install. Sized like the owner's own
 * `SESSION_INIT_TIMEOUT_MS`: the guest materializes the workspace to disk and
 * runs `ensureProjectShape`, so this is real work, not a ping.
 */
const ADOPT_TIMEOUT_MS = 30_000;

/** Everything the guest needs to (re)install the session, minus the token. */
export type AdoptSessionParams = {
  scope: string;
  project: string;
  files: Record<string, string>;
  apiKey: string;
  system: string;
  model: string;
  region?: "eu" | undefined;
  maxSteps: number;
};

export type AdoptDeps = {
  /** Test seam — defaults to the global fetch. */
  fetchFn?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * Install `params` into the peer's guest and return its chat URL + token, or
 * null when the guest could not be reached or refused.
 *
 * The `chatToken` comes FROM the record and goes back unchanged: it is minted
 * once per sandbox, so every replica must return the same one or the tabs
 * holding the earlier value start 401ing on the chat surface.
 */
export async function adoptPeerSession(
  record: StudioSessionRecord,
  params: AdoptSessionParams,
  deps: AdoptDeps = {},
): Promise<{ url: string; token: string } | null> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const url = guestHttpUrl(record.guestOrigin, GUEST_ROUTES.studioSessionInit);
  try {
    const res = await pTimeout(
      fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${record.sandboxToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...params, chatToken: record.chatToken }),
      }),
      { milliseconds: deps.timeoutMs ?? ADOPT_TIMEOUT_MS, message: "session-init timed out" },
    );
    if (!res.ok) {
      log.warn("peer install refused; respawning sandbox", {
        project: params.project,
        status: res.status,
      });
      return null;
    }
    return { url: record.chatUrl, token: record.chatToken };
  } catch (err) {
    // Dead guest (idle-evicted, crashed, replica gone) or a slow one — either
    // way this replica must not hand its URL to a browser.
    log.warn("peer unreachable; respawning sandbox", {
      project: params.project,
      error: errorMessage(err),
    });
    return null;
  }
}
