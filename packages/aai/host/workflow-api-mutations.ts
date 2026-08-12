// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow API's run MUTATIONS — cancel, retry, and resolving a waitpoint.
 *
 * Split from `workflow-api.ts` when it reached the 500-line cap. The seam is that
 * all three answer 200 carrying a boolean rather than a status code, for one shared
 * reason: "the run was already terminal", "nothing is parked on that token" and "no
 * such run" are ANSWERS rather than errors, and two operators pressing Stop — or a
 * webhook retrying — is ordinary. The reads and the router stay in that file.
 *
 * @internal
 */

import type http from "node:http";
import {
  MAX_WORKFLOW_INPUT_BYTES,
  readBody,
  sendJson,
  type WorkflowApiEngine,
} from "./workflow-api-http.ts";

/**
 * `DELETE /workflows/runs/:id` — stop a run.
 *
 * 200 either way, carrying whether this call is what ended it: a run that was
 * already terminal is not an error (two tabs pressing Stop is ordinary), and a
 * 404 would conflate "no such run" with "already finished". A run id that never
 * existed answers `{ cancelled: false }` for the same reason `get` is the route
 * that reports existence.
 */
export async function cancelRun(
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  const cancelled = runId ? await engine.cancel(runId) : false;
  sendJson(res, 200, { runId, cancelled });
}

/**
 * `POST /workflows/runs/:id/retry` — send a terminal run back to the queue.
 *
 * 200 either way with `retried`, mirroring `cancelRun`: a run that is still live
 * (or already gone) is not an ERROR, it is an answer, and two operators pressing
 * Retry is as ordinary as two pressing Stop.
 */
export async function retryRun(
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  runId: string,
): Promise<void> {
  const retried = runId ? await engine.retry(runId) : false;
  sendJson(res, 200, { runId, retried });
}

/**
 * `POST /workflows/signals/:token` — resolve a waitpoint.
 *
 * The token is in the PATH rather than the body, so the whole thing is a URL you
 * can email, paste into a provider's webhook field, or curl. That is the point of
 * a waitpoint: the run is parked and whoever holds the token is the only thing
 * that can release it.
 *
 * **It is NOT under `/runs/:id`**, and that is deliberate: the token alone
 * identifies the waitpoint (the column is unique), so requiring the run id too
 * would mean handing out both halves and would let a caller who knows a run id
 * probe for its token. The run id comes back in the response instead, for a
 * caller that wants to poll the run afterwards.
 *
 * 200 with `signalled: false` for a token nothing is parked on — an unknown token,
 * one already used (they are single-use), or a wait that timed out and moved on.
 * A 404 would conflate those three, and a retrying webhook meets the second one
 * routinely, so this mirrors `cancelRun`/`retryRun`: not an error, an answer.
 */
export async function signalWait(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: WorkflowApiEngine,
  token: string,
): Promise<void> {
  if (!token) {
    sendJson(res, 400, { error: "A signal needs a token: POST /workflows/signals/<token>" });
    return;
  }
  // The payload is whatever the caller sends, capped like a run input and
  // journaled as the value `ctx.waitFor` returns. An empty body is legal and
  // resolves the wait with `undefined` — plenty of waitpoints are a doorbell
  // rather than a message.
  const body = await readBody(req, MAX_WORKFLOW_INPUT_BYTES);
  const payload = body.length === 0 ? undefined : (JSON.parse(body.toString("utf-8")) as unknown);
  const runId = await engine.signal(token, payload);
  sendJson(res, 200, { signalled: runId !== undefined, ...(runId ? { runId } : {}) });
}
