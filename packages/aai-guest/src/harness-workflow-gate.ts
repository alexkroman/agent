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
 * `aai dev` and a self-hosted `createRuntimeServer` have no platform and no
 * `AAI_GUEST_TOKEN`, so this gate lives in the DEPLOYED-guest request hook only
 * (`createAgentRequestHandler`) and never runs there. What it must NOT rest on is
 * that fact plus `harness.ts`'s boot refusal — see
 * {@link gateDirectWorkflowDial} on why a blank token is refused at both ends
 * here rather than trusted to a check in another file.
 */

import type http from "node:http";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/internal";
import { constantTimeEquals } from "./harness-auth.ts";
import { writeJson } from "./harness-http.ts";

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
 * and the public webhook, mounted by `createRuntimeServer` and authenticated by the
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
 * A token neither end can present — no token at all, rather than a short one.
 *
 * Whitespace-only counts as blank because a header value arrives with its
 * optional whitespace already stripped, so `x-aai-guest-token:` and
 * `x-aai-guest-token:   ` are the same `""` on this side and a whitespace-only
 * EXPECTED token is one nothing can be sent to match.
 *
 * This is a fourth copy of `isBlankSecret` (`aai-runtime/bearer.ts`), whose doc
 * carries the argument, and it is a copy on purpose: that function is
 * deliberately NOT on `@alexkroman1/aai-runtime/internal` — `internal.ts` says so
 * in as many words, on the reasoning that its one out-of-package caller
 * (`aai-server/guest-bearer.ts`) is safe by its own ordering. This gate is the
 * second such caller and is not, so it re-derives the predicate rather than
 * widening a published surface.
 */
function isBlankToken(token: string): boolean {
  return token.trim() === "";
}

/**
 * Refuse a direct tunnel dial of the workflow API.
 *
 * Returns true when it has ANSWERED (a 401 — the caller must leave the response
 * alone), and false to fall through: either the path is not the workflow API, or
 * the manage bearer checks out and the runtime's own API should serve it (and
 * apply the `AAI_WORKFLOW_API_TOKEN` gate).
 *
 * ## A blank token at EITHER end is refused, and the two catch different things
 *
 * `constantTimeEquals("", "")` is TRUE — `timingSafeEqual` on two empty buffers
 * matches — so a caller sending an empty `x-aai-guest-token` against a blank
 * `proxyToken` used to fall straight through this gate onto the public tunnel.
 * It was safe only because `harness.ts` exits when `AAI_GUEST_TOKEN` is falsy,
 * which is a defence in a DIFFERENT FILE guarding a comparison in this one — the
 * shape that breaks the day somebody edits the other file, and precisely why
 * `bearerMatches` in the runtime was taught to refuse a blank expected secret at
 * the comparison as well as at the env read that feeds it.
 *
 * So both ends are guarded, with distinct jobs:
 *
 * - **The EXPECTED side** (`proxyToken`) is what closes the hole. A blank
 *   expected token is not a credential anyone can satisfy, so it 401s every
 *   workflow request rather than admitting one — failing CLOSED, which is the
 *   right way round for a surface reachable from a public tunnel. It catches the
 *   MISCONFIGURATION wherever it comes from, including a caller of this exported
 *   function that never went through the harness's boot check at all. That is
 *   what makes the gate safe on its own terms rather than by a distant `exit(1)`.
 * - **The SUPPLIED side** catches nothing the expected guard does not — a
 *   non-blank expected token can never equal an empty supplied one, the length
 *   compare refusing first. What it buys is that an empty comparison is
 *   STRUCTURALLY unreachable: the property `aai-server/guest-bearer.ts` describes
 *   as being safe "by two independent facts", so weakening either guard later
 *   does not reopen the door by itself.
 */
export function gateDirectWorkflowDial(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  proxyToken: string,
): boolean {
  if (!isWorkflowApiPath(url)) return false;
  const supplied = req.headers[GUEST_PROXY_TOKEN_HEADER];
  if (
    typeof supplied === "string" &&
    !isBlankToken(supplied) &&
    !isBlankToken(proxyToken) &&
    constantTimeEquals(supplied, proxyToken)
  ) {
    return false;
  }
  writeJson(res, 401, { error: "unauthorized" });
  return true;
}
