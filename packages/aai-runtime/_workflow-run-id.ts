// Copyright 2026 the AAI authors. MIT license.
/**
 * The run id in a `/workflows/runs/:id` path — decoded, checked, or answered
 * 400.
 *
 * Its own module for the same reason `uploadIdOr400` sits beside the upload
 * routes rather than in the router: this is the whole content of one decision,
 * and `workflow-api.ts` is at the 500-line cap. The router calls it for every
 * verb under the prefix, which is the property that matters — see below.
 *
 * @internal
 */

import type http from "node:http";
import { decodePathSegment } from "./_path-decode.ts";
import { sendJson } from "./workflow-api-http.ts";

/**
 * Characters a run id may not contain, plus the empty id — the file-backed
 * world's OWN rule, enforced here so it is a boundary rather than a fault.
 *
 * A run id is `wrun_` + a ULID, so nothing legitimate holds any of these. What
 * does hold them is a hand-written request target, and the local world (`aai
 * dev` with no `DATABASE_URL`) refuses one correctly and by THROWING:
 * `Unsafe runId "wrun_../etc": must not be empty, contain ".", "/", "\", or
 * null bytes`. There is no traversal — the store defends itself — but the
 * router's catch reported that refusal as `500 Internal server error`, i.e.
 * "the agent is broken", for a plainly bad request target. Postgres has no such
 * rule and simply 404s, which is how it stayed invisible until an e2e run drove
 * the local world.
 *
 * Same remedy as `uploadIdOr400`, and the same reason its doc gives: the
 * grammar is a BOUNDARY, so an id that would escape a store never reaches one,
 * whichever verb asked. A REJECT list rather than an allow list, because the
 * ids are the DevKit's to mint and this only has to name what no store can
 * hold. NUL is absent deliberately — `decodePathSegment` answers it first.
 */
const UNSAFE_RUN_ID_RE = /[./\\]/;

/** What a run id that cannot address anything is answered with. */
const UNSAFE_RUN_ID_MESSAGE = 'A run id may not be empty or contain ".", "/" or "\\".';

/**
 * The run id in this path, or `undefined` having ALREADY answered 400.
 *
 * A path segment is percent-decoded, and `decodeURIComponent` throws a
 * `URIError` on a malformed escape — so `GET /workflows/runs/%` used to reach
 * the router's catch and answer 500 for what is plainly a bad request. See
 * `_path-decode.ts`: none of the decode sites in this package may throw, and
 * each answers the way its own route answers a request it cannot parse.
 */
export function runIdOr400(
  res: http.ServerResponse,
  url: string,
  prefix: string,
  suffix = "",
): string | undefined {
  const id = decodePathSegment(url.slice(prefix.length, suffix ? -suffix.length : undefined));
  if (id === undefined) {
    sendJson(res, 400, { error: "Malformed run id" });
    return undefined;
  }
  if (id === "" || UNSAFE_RUN_ID_RE.test(id)) {
    sendJson(res, 400, { error: UNSAFE_RUN_ID_MESSAGE });
    return undefined;
  }
  return id;
}
