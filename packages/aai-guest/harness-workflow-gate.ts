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
 * The `/.well-known/workflow/v1/*` queue callbacks are a different prefix and
 * loopback-gated — `handleWorkflowRequest` claims those before this runs — so
 * they are deliberately NOT matched here.
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
