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
import { responseErrorMessage } from "./utils.ts";

/**
 * Path prefix every route lives under, relative to the agent's own base URL.
 *
 * Defined on this side and re-exported by `host/workflow-api.ts` (and so by
 * `@alexkroman1/aai/runtime`, which is where the server and the `aai dev` proxy
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

/** Read the agent's error sentence out of a failed response. */
export async function apiFailure(res: Response): Promise<Error> {
  return new Error(await responseErrorMessage(res, WORKFLOW_API_ERROR_LABEL));
}

/**
 * A successful body, parsed — labelled, because the status does NOT decide
 * whether a body is JSON: a proxy's `200 text/html` used to reject with a bare
 * `SyntaxError` carrying no status and no `runId`. See {@link readJsonBody}.
 */
export function readApiJson<T>(res: Response): Promise<T> {
  return readJsonBody<T>(res, WORKFLOW_API_ERROR_LABEL);
}
