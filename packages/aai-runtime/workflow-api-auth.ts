// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow HTTP API's authentication posture, and the whole argument for it.
 *
 * Its own module because `workflow-api.ts` sat at 494 lines against the 500-line
 * cap and this reasoning is most of what was wrong with that file — the same
 * move `workflow-storage-apply.ts` made out of `workflow-storage-handler.ts`.
 * The GATE itself is four lines; everything else here is the decision.
 *
 * ## The surface is as public as `/websocket` beside it, and that stays true
 *
 * A page carries no credential — it is served to anyone who has the URL, exactly
 * like the voice client — so requiring one by default would mean no static page
 * (`AgentDef.page: "static"`) could ever work. Anyone who knows a slug can
 * already open a voice session and spend the tenant's provider budget. Fail-OPEN
 * when unset is the documented default, not an oversight.
 *
 * ## Three exposure shapes, and this doc used to name only one
 *
 * It named the COST shape, and #1309 flagged that as the whole gap: the module
 * "reasons only about cost exposure of failing open, never about the
 * read-and-cancel side". The three are worth separating because they have
 * different mitigations and only one of them is mitigated today.
 *
 * **1. COST.** A run outlives the request that started it, so a loop of cheap
 * `POST /runs` queues far more work than a loop of voice sessions. This is the
 * one the old doc named — and it is the one ALREADY BOUNDED: the platform applies
 * per-IP limits in front of this surface (`WORKFLOW_IP_RATE_LIMIT`, and a much
 * tighter `WORKFLOW_START_IP_RATE_LIMIT` on the start route). So the doc led with
 * the exposure that has a mitigation and was silent about the two that do not.
 *
 * **2. DISCLOSURE, and the hinge is the UNKEYED arm of `GET /runs`.** The two
 * arms of that one route are different questions, and `findRuns` already says so
 * in place: `?workflow=X&key=K` is `find`, which reads OUR key index and needs
 * the correlation key the CALLER chose; `?workflow=X` alone is `recent`, which
 * reads the DevKit's own store and returns that workflow's recent runs whatever
 * key they carry — its own comment calls it "the operator's read (a console has
 * no key to ask about)". That arm is the one route on this surface that converts
 * *knowing a slug* into *knowing run ids*, and run ids are what everything in (3)
 * treats as a capability. It is bounded in SIZE (`resolveFindLimit` clamps
 * `limit` to `MAX_WORKFLOW_FIND_LIMIT`, so there is no unbounded read here) and
 * unbounded in KIND.
 *
 * **3. INTEGRITY — `DELETE /runs/:id` and `POST /runs/:id/wake`.** Neither costs
 * the tenant money; both change a run somebody else started, which no rate limit
 * addresses. They are capability-protected in the ordinary sense — a `wrun_` id
 * is a ULID nobody guesses, and `ctx.workflows.start()` hands it only to the
 * caller that started the run — but that protection is exactly as good as the
 * promise that nothing else hands ids out, which is the promise (2) breaks.
 *
 * So the posture is coherent for the case it was designed for (a page starts a
 * run and reads, streams or cancels THAT run, holding the id it was given) and
 * the enumeration arm is what makes it incoherent for the case it was not.
 *
 * ## What is NOT decided here
 *
 * Whether the unkeyed arm should require the token independently of the rest —
 * i.e. keep start/read/cancel-by-id open, close enumeration always. That is the
 * shape the reasoning above points at, and it is deliberately NOT implemented,
 * because it is a posture change with two costs a doc should not spend on its
 * own: `aai workflow` listing and the studio's runs card both read that arm, and
 * in a tokenless deployment (the default) they would go from working to 401. An
 * operator running anything beyond a self-service page should set
 * {@link WORKFLOW_API_TOKEN_ENV} today; that is the honest advice until the
 * question above is answered either way.
 *
 * @module
 */

import type http from "node:http";
import { bearerMatches, sendJson } from "./workflow-api-http.ts";

/**
 * Env var holding the bearer this API requires. Unset leaves it OPEN — see the
 * module doc, which carries the full posture and the three exposure shapes.
 *
 * Nothing sets this automatically: not the CLI, not the platform, not a deploy.
 * It is the author's to set, surfaced in the studio's Secrets pane and named by
 * its API-docs card ("Open by default"). A deployed agent that never sets it
 * serves every route below to anyone who knows its slug.
 */
export const WORKFLOW_API_TOKEN_ENV = "AAI_WORKFLOW_API_TOKEN";

/**
 * Whether this request is refused, HAVING ALREADY answered 401 when it is.
 *
 * Called before the engine is resolved, which is the load-bearing half:
 * resolving BUILDS the runtime inside the guest, so an unauthenticated caller
 * must not be able to trigger it. `workflow-api.test.ts` pins that, and pins the
 * gate on the three routes #1309 named (the run listing, cancel and wake) rather
 * than only on the cheap `GET /workflows` it used to cover — a token check that
 * moved inside a route would otherwise leave the destructive verbs open with the
 * suite green.
 *
 * `token` undefined means OPEN, and is the default. See the module doc.
 *
 * **A BLANK token means neither open nor closed by this line, and used to mean
 * open by accident.** `""` is not `undefined`, so it reached `bearerMatches`,
 * where `timingSafeEqual` on two empty buffers MATCHES — so `AAI_WORKFLOW_API_TOKEN=`
 * left every route here serving anyone while reading as closed. `bearerMatches`
 * refuses a blank secret now, so this gate answers 401 for one; `createServer`
 * reads the variable through `agentGateToken`, which reports a blank one as
 * absent and logs why, so the surface lands on the documented default rather
 * than 401ing `aai workflow` and the studio's runs card with no explanation.
 *
 * @internal
 */
export function workflowApiUnauthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string | undefined,
): boolean {
  if (token === undefined || bearerMatches(req.headers.authorization, token)) return false;
  sendJson(res, 401, { error: "Missing or invalid workflow API token" });
  return true;
}
