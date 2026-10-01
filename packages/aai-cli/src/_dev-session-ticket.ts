// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev` with `AAI_SESSION_SECRET` set: the dev server mints a session ticket
 * for the client it serves itself.
 *
 * Without this, setting the secret (to exercise the ticket check before a
 * self-hosted deploy) refused the default client: it had no way to get a
 * ticket. So `GET /client-config` carries a fresh one (`sessionToken`) on every
 * lookup, and the browser client re-fetches that config on every connection
 * attempt, so a reconnect is never presenting an expired ticket.
 *
 * **This makes the dev page itself the credential holder** — anyone who can
 * load it gets a ticket, which is what serving a client means. That is fine for
 * a dev server (loopback by default; `AAI_DEV_HOST` widens it on purpose) and is
 * exactly why a self-hosted `createRuntimeServer` NEVER does it: there,
 * `client-config` is unauthenticated, and tickets come from the operator's own
 * backend after its own login check (`createSessionToken` on
 * `@alexkroman1/aai-runtime/auth`, the browser's `token` option).
 *
 * **Resume ownership is waived here, deliberately.** Every ticket this minter
 * issues names the same identity, and a file save rebuilds the server — and
 * with it the gate's record of who opened which session — so the self-hosted
 * rule ("resume only what this process saw you open") would refuse the
 * reconnect after every save, fatally. The verifier therefore binds each valid
 * ticket to the session its upgrade resumes. A ticket presented by a client the
 * dev server did not mint for (your own `token` getter) is checked the same way,
 * with the same secret.
 */

import type http from "node:http";
import { parseWsUpgradeParams } from "@alexkroman1/aai/internal";
import { buildClientConfig, CLIENT_CONFIG_PATH } from "@alexkroman1/aai/protocol";
import {
  createSessionAuth,
  createSessionToken,
  SESSION_SECRET_ENV,
  type SessionAuth,
  type SessionIdentity,
  verifySessionToken,
} from "@alexkroman1/aai-runtime/auth";

/** The identity every dev-minted ticket names. */
export const DEV_TICKET_SUB = "aai-dev";

/** What the dev server's `client-config` describes, besides the ticket. */
export type DevClientConfigSource = {
  name: string;
  greeting?: string | undefined;
  page?: "voice" | "static" | undefined;
};

/** The part of an `http.ServerResponse` the `client-config` answer writes. */
export type ClientConfigResponse = {
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body: string): unknown;
};

/** The two server options that turn dev ticketing on. */
export type DevSessionTicketing = {
  /** The gate: dev tickets, resume bound to the upgrade (see the module doc). */
  auth: SessionAuth;
  /**
   * The `request` hook answering `GET /client-config` with a fresh ticket.
   * `true` when it answered, `undefined` to fall through (so `??` composes it).
   */
  clientConfig: (
    req: unknown,
    res: ClientConfigResponse,
    url: string,
    method: string,
  ) => true | undefined;
};

/**
 * The dev gate's ticket check: the built-in HMAC ticket, bound to the session
 * the upgrade resumes (see the module doc for why ownership is waived).
 */
export function devTicketVerifier(
  secret: string,
): (token: string, req: http.IncomingMessage) => SessionIdentity | undefined {
  return (token, req) => {
    const identity = verifySessionToken(token, { secret });
    if (identity === undefined) return;
    // The id the SERVER will treat as the resume, parsed by the same function.
    const { resumeFrom } = parseWsUpgradeParams(req.url ?? "");
    return resumeFrom === undefined ? identity : { ...identity, sessionId: resumeFrom };
  };
}

/**
 * Dev ticketing for this build's server, or `undefined` when
 * `AAI_SESSION_SECRET` is unset or blank — the dev server is then exactly what
 * it was. Read from the same env the server's gate reads.
 */
export function devSessionTicketing(
  env: Readonly<Record<string, string>>,
  source: DevClientConfigSource,
): DevSessionTicketing | undefined {
  const secret = env[SESSION_SECRET_ENV];
  // Blank is unset, as `resolveSessionGate` treats it (it logs that, once).
  if (secret === undefined || secret.trim() === "") return undefined;

  const clientConfigPath = `/${CLIENT_CONFIG_PATH}`;
  return {
    auth: createSessionAuth({ verify: devTicketVerifier(secret) }),
    clientConfig: (_req, res, url, method) => {
      if (url !== clientConfigPath || method !== "GET") return;
      const body = buildClientConfig({
        ...source,
        sessionToken: createSessionToken({ secret, sub: DEV_TICKET_SUB }),
      });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
      return true;
    },
  };
}
