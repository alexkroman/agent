// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a workflow API request goes, and what its answer amounts to.
 *
 * Split out of `workflow-api-client.ts`, which is about the ROUTES: one method
 * per route, and nothing else. These are the envelope every one of them shares
 * — the root they resolve under, the agent's own sentence out of a failure, and
 * the guard over a 2xx that is not JSON — so they are the seam that module has,
 * and moving them keeps it inside the 500-line cap rather than growing a second
 * copy of any of this beside the routes.
 *
 * `_`-internal: the client is the only caller. `WORKFLOW_API_PREFIX` lives here
 * with the resolver that joins it and is re-exported by the client, so every
 * importer still reads it from the one public place.
 */

import { readJsonBody } from "./response-body.ts";
import { isRecord, responseErrorMessage } from "./utils.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * Path prefix every route lives under, relative to the agent's own base URL.
 *
 * Defined on this side and re-exported by `host/workflow-api.ts` (and so by
 * `@alexkroman1/aai-runtime`, which is where the server and the `aai dev` proxy
 * table read it from). One literal for both ends: a client asking for a path the
 * server does not serve is a 404 that reads as a missing feature, and the dev
 * proxy getting it wrong is a workflow app that is dead on arrival under
 * `aai dev` while the backend serves the whole API one port over. It could not
 * live in `host/` and be shared, because a browser cannot import that half.
 *
 * @public
 */
export const WORKFLOW_API_PREFIX = "/workflows";

/**
 * Label put in front of a status when the answer was NOT this API's `{ error }`
 * shape — see {@link responseErrorMessage}, which prefixes nothing when the
 * agent gave its own sentence. It names the surface that answered, which is the
 * one thing a bare `502: <html>` does not say.
 */
export const WORKFLOW_API_ERROR_LABEL = "Workflow API";

/**
 * Resolve the API root under an agent's base URL.
 *
 * ONE resolver rather than a trailing-slash rule per call site — two of those is
 * how the browser session's endpoints and this one drifted. The prefix is
 * stripped of its leading `/` before it is joined, because `new URL("/x", base)`
 * is ABSOLUTE and would drop the agent's own path segment, turning every request
 * for a deployed agent into a request for the platform root.
 */
export function apiRoot(baseUrl: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(WORKFLOW_API_PREFIX.replace(/^\//, ""), base).toString();
}

/**
 * A failure that came from a RESPONSE, so it knows which one.
 *
 * The message is the agent's own sentence and deliberately does not carry the
 * status (see {@link WORKFLOW_API_ERROR_LABEL}), which left the status
 * unreachable to anything downstream — fine while every caller did the same
 * thing with every failure, and not fine once one of them had to tell "come
 * back" from "no": see `_upload-resume.ts`, where the difference is between
 * waiting out a redeploy and re-sending a file the agent has already refused.
 */
export type ApiFailure = Error & { status: number };

/** Read the agent's error sentence out of a failed response. */
export async function apiFailure(res: Response): Promise<ApiFailure> {
  return Object.assign(new Error(await responseErrorMessage(res, WORKFLOW_API_ERROR_LABEL)), {
    status: res.status,
  });
}

/**
 * The status a failure carried, or nothing.
 *
 * Nothing means the failure was not an answer at all — a dropped connection, a
 * DNS miss, a request that never completed — which is the case a caller usually
 * treats most generously, since there is no far side saying no.
 */
export function failureStatus(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  const status = err.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * A successful body, parsed — labelled, because the status does NOT decide
 * whether a body is JSON: a proxy's `200 text/html` used to reject with a bare
 * `SyntaxError` carrying no status and no `runId`. See {@link readJsonBody}.
 */
export function readApiJson<T>(res: Response): Promise<T> {
  return readJsonBody<T>(res, WORKFLOW_API_ERROR_LABEL);
}

/**
 * The snapshot a `startAndWait` falls back to when the run exists and the answer
 * carried no snapshot for it.
 *
 * Reachable only against an agent that answered `{ runId }` alone despite a
 * `wait` — a proxy that rewrote the body, or a replica that has not yet seen its
 * own write. Saying `pending` is both true and useful: the caller has the id,
 * and reading it again takes it from there.
 *
 * Here rather than beside its one caller because `workflow-api-client.ts` is at
 * the 500-line cap and this is envelope-shaping, which is what this module is.
 */
export function pendingRun(runId: string, workflow: string): WorkflowRunSnapshot {
  return { runId, workflow, createdAt: Date.now(), status: "pending" };
}
