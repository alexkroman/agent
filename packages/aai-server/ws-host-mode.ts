// Copyright 2026 the AAI authors. MIT license.
/**
 * Host mode for deployed agents — the platform's counterpart to the dev
 * server's `?host=1` WebSocket.
 *
 * A host-mode connection supplies its own `systemPrompt`, `greeting`, and
 * relayed tool schemas, and the session runs on the *deployed agent's*
 * credentials and provider pipeline. That is the point (a harness drives a
 * real agent), and it is also why the gate here differs from the dev
 * server's:
 *
 * - `aai dev` is single-user and loopback-bound, so an operator env flag
 *   (`AAI_ALLOW_HOST`) is an adequate control.
 * - The platform is multi-tenant and an agent's WebSocket is deliberately
 *   *unauthenticated* — anyone with the URL can talk to it. Allowing prompt
 *   and tool overrides on that same footing would turn every deployed agent
 *   into an open LLM proxy billed to its owner. So overrides require proving
 *   ownership of the slug, the same check `/:slug/secret` and `/:slug/storage`
 *   already use. An env flag would be all-or-nothing across tenants.
 *
 * Plain (non-host) connections are untouched and stay unauthenticated.
 */

import type { SessionStartOptions, SessionWebSocket } from "@alexkroman1/aai/runtime";
import { startHostSession } from "@alexkroman1/aai/runtime";
import { parseBearer } from "./_bearer.ts";
import { answerUpgrade, type UpgradeReplySocket } from "./_upgrade-reply.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { toRuntimeAgent } from "./sandbox-agent-config.ts";
import { verifySlugOwner } from "./secrets.ts";
import type { BundleStore } from "./store-types.ts";

/** Header carrying the owner's API key on a host-mode upgrade. */
const AUTH_HEADER = "authorization";

/** True when the upgrade URL asks for host mode. */
export function wantsHostMode(rawUrl: string): boolean {
  const query = rawUrl.split("?")[1] ?? "";
  return new URLSearchParams(query).get("host") === "1";
}

/**
 * Bearer token from an upgrade request.
 *
 * Header only — deliberately not a query parameter. A URL travels through
 * proxy logs, browser history, and Referer headers, and this token is the
 * caller's whole platform credential. Browsers cannot set headers on a
 * WebSocket, which is intentional: host mode is for programmatic clients.
 */
export function bearerToken(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers[AUTH_HEADER];
  return parseBearer(Array.isArray(raw) ? raw[0] : raw);
}

export type HostModeAuth = { allowed: true } | { allowed: false; code: number; reason: string };

/**
 * Decide whether a host-mode upgrade may proceed.
 *
 * Returns a close code and reason rather than throwing, so the caller can
 * answer the handshake instead of dropping the socket unexplained.
 */
export async function authorizeHostMode(
  slug: string,
  headers: Record<string, string | string[] | undefined>,
  store: BundleStore,
): Promise<HostModeAuth> {
  const apiKey = bearerToken(headers);
  if (!apiKey) {
    return {
      allowed: false,
      code: 401,
      reason:
        "host mode requires the agent owner's API key — send Authorization: Bearer <key> on the upgrade request",
    };
  }
  const result = await verifySlugOwner(apiKey, { slug, store });
  if (result.status !== "owned") {
    // "unclaimed" and "forbidden" collapse to one answer: a caller who does
    // not own the slug learns nothing about whether it exists.
    return { allowed: false, code: 403, reason: "host mode requires the agent owner's API key" };
  }
  return { allowed: true };
}

/**
 * Gate a host-mode WebSocket upgrade (the caller has already established
 * `wantsHostMode`).
 *
 * Returns true when the connection proved ownership. On refusal it answers
 * the handshake with a real HTTP status and destroys the socket, because a
 * bare RST is indistinguishable from a network fault to the caller.
 */
export async function guardHostModeUpgrade(opts: {
  slug: string;
  headers: Record<string, string | string[] | undefined>;
  store: BundleStore;
  socket: UpgradeReplySocket;
}): Promise<boolean> {
  const auth = await authorizeHostMode(opts.slug, opts.headers, opts.store);
  if (auth.allowed) return true;
  const status = auth.code === 401 ? "Unauthorized" : "Forbidden";
  answerUpgrade(opts.socket, `${auth.code} ${status}`, `${auth.reason}\n`);
  return false;
}

/**
 * Begin a host-mode session on a deployed agent.
 *
 * Runs in this process rather than the guest sandbox: host mode replaces the
 * agent's tools with ones relayed back to the caller, so there is no tenant
 * code to isolate. The credentials and provider pipeline are still the
 * deployed agent's — which is the point, and why ownership was checked before
 * the upgrade completed.
 */
export function startDeployedHostSession(
  ws: SessionWebSocket,
  opts: {
    slug: string;
    agentConfig: IsolateConfig;
    store: BundleStore;
    startOpts: SessionStartOptions;
  },
): void {
  // startHostSession attaches the handshake `message` listener SYNCHRONOUSLY
  // — the client's config frame is the first frame of the protocol and can
  // arrive the moment the 101 completes, and `ws` does not buffer for late
  // listeners. Awaiting the Vault fetch before calling it lost that frame
  // whenever the fetch was slower than the client, failing the connection on
  // the handshake timeout. The env rides along as a promise instead, awaited
  // only once the handshake has landed; a rejected fetch is reported to the
  // client as a handshake rejection there. The pre-observation `.catch`
  // keeps a fetch that fails before any handshake from becoming an
  // unhandled rejection (the returned promise — with the handler attached —
  // is what the session awaits, not this observer).
  const envPromise = opts.store.getEnv(opts.slug).then((agentEnv) => agentEnv ?? {});
  envPromise.catch((err: unknown) => {
    console.error(`Host-mode env fetch failed for ${opts.slug}:`, err);
  });
  startHostSession(ws, {
    env: envPromise,
    // toRuntimeAgent keeps the provider descriptors on the agent, so a
    // pipeline agent driven over ?host=1 stays a pipeline agent.
    baseAgent: toRuntimeAgent(opts.agentConfig),
    // Ownership was verified at the upgrade; the platform's gate is the
    // API key, not AAI_ALLOW_HOST (which would be all-or-nothing).
    allowHost: true,
    startOpts: opts.startOpts,
  });
}
