// Copyright 2026 the AAI authors. MIT license.
/**
 * Keep `/workflows/*` PLATFORM-ONLY on a deployed guest.
 *
 * `/workflows/*` is declared `via: "proxied"` in aai-server's
 * `GUEST_ROUTE_EXPOSURE` — the platform is the only intended caller, which is
 * what lets its per-IP rate limiters bound this cost-bearing surface (each run
 * spends the tenant's provider budget and keeps a sandbox resident). But the
 * sandbox tunnel is PUBLIC: `/client-config` hands the guest's `w.modal.host`
 * URL to browsers for the voice session, so without a gate a caller who reads
 * that config reaches the workflow API straight on the tunnel and every platform
 * limiter is off the path.
 *
 * The platform proves it is the caller by injecting {@link GUEST_PROXY_TOKEN_HEADER}
 * with this sandbox's manage bearer (`AAI_GUEST_TOKEN`), which a direct dialer
 * cannot forge — it is an HMAC over the sandbox's fleet-wide name. A SEPARATE
 * header from `Authorization` deliberately: `Authorization` still carries the
 * caller's own `AAI_WORKFLOW_API_TOKEN`, which the runtime's workflow API checks
 * downstream, so the two gates compose ("did this come through the platform" and
 * "does the caller hold the app's workflow token").
 *
 * `aai dev` and a self-hosted `createServer` have no platform and no
 * `AAI_GUEST_TOKEN`, so this gate lives in the DEPLOYED-guest request hook only
 * (`createAgentRequestHandler`) and never runs there.
 */

import type http from "node:http";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/internal";
import { constantTimeEquals } from "./harness-auth.ts";

/**
 * Header the platform injects to prove a `/workflows/*` request came through it.
 *
 * Must equal `aai-server`'s `GUEST_PROXY_TOKEN_HEADER` — this is the same
 * platform↔guest contract as `AAI_GUEST_TOKEN` itself, duplicated across the
 * boundary rather than shared (a mismatch 401s every workflow request, LOUD).
 */
export const GUEST_PROXY_TOKEN_HEADER = "x-aai-guest-token";

/**
 * Is `url` the workflow RUN API (`/workflows`, `/workflows/runs`, …)?
 *
 * The `/.well-known/workflow/v1/*` routes are a different prefix and carry
 * their own gates, so they are deliberately NOT matched here. Two remain: the
 * platform's delivery door (`POST /workflow-queue`, which `handleWorkflowRequest`
 * claims before this runs and which fails CLOSED without the platform's bearer),
 * and the public webhook, mounted by `createServer` and authenticated by the
 * unguessable token IN its path.
 *
 * The DevKit's `flow` and `step` were the other two, and they are why this
 * comment is worth reading rather than deleting: they were unauthenticated
 * BECAUSE loopback was meant to be the whole gate, an earlier version of this
 * very comment asserted that gate, and nothing checked — so
 * `POST <tunnel>/.well-known/workflow/v1/step` executed a tenant's registered
 * step function for anyone on the internet. Both routes are gone, so the hole is
 * closed by construction. See the module doc of
 * `aai-runtime/workflow-serve.ts`.
 */
function isWorkflowApiPath(url: string): boolean {
  return url === WORKFLOW_API_PREFIX || url.startsWith(`${WORKFLOW_API_PREFIX}/`);
}

/**
 * Refuse a direct tunnel dial of the workflow API.
 *
 * Returns true when it has ANSWERED (a 401 — the caller must leave the response
 * alone), and false to fall through: either the path is not the workflow API, or
 * the manage bearer checks out and the runtime's own API should serve it (and
 * apply the `AAI_WORKFLOW_API_TOKEN` gate).
 */
export function gateDirectWorkflowDial(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  proxyToken: string,
): boolean {
  if (!isWorkflowApiPath(url)) return false;
  const supplied = req.headers[GUEST_PROXY_TOKEN_HEADER];
  if (typeof supplied === "string" && constantTimeEquals(supplied, proxyToken)) return false;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return true;
}
