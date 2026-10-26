// Copyright 2026 the AAI authors. MIT license.
/**
 * `/api/v1/calls` — the HTTP API that places calls and reads them back.
 *
 * ```sh
 * curl "$AGENT_URL/api/v1/calls" \
 *   -H "Authorization: $CALLS_API_KEY" \
 *   -H "Content-Type: application/json" \
 *   -d '{"phone_number": "+14155550132", "prompt": "Call Maria for Mission Dental…",
 *        "webhook_url": "https://example.com/hooks/calls"}'
 * ```
 *
 * | Route | Answers |
 * | --- | --- |
 * | `POST /v1/calls` | `201` and the queued {@link CallRecord} — the call is dialled in the background |
 * | `GET /v1/calls/:id` | the call as it stands: its status line while it is going, the full record once done |
 * | `GET /v1/calls` | the most recent calls, newest first |
 *
 * Every route sits behind `apiKeyRoute`, which checks `Authorization` against
 * `CALLS_API_KEY` (a bare key or `Bearer <key>`) in constant time:
 * `agent({ routes })` is as open as the server, and a route that dials a phone
 * is not one to leave open.
 *
 * Each call is one run of the `call` workflow, started with `key` = the call
 * id, so the API stores nothing of its own: a read is `find(call, id)`.
 */

import {
  apiKeyRoute,
  route,
  routeError,
  routeResponse,
  type WorkflowRunOf,
} from "@alexkroman1/aai";
import { describeRun } from "@alexkroman1/aai/workflow-api";
import type { CallList, CallRecord } from "./api-types.ts";
import call, { callRequest } from "./workflows/call.ts";

/** Most calls `GET /v1/calls` lists. */
export const LIST_LIMIT = 50;

/** The shared secret every route is behind. */
const AUTH = { env: "CALLS_API_KEY" };

/** A fresh call id: `call_` and sixteen random hex characters. */
export function newCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * What a run says about its call. A finished run's output IS the record; an
 * unfinished one carries the run's own status line as its summary so far.
 */
export function toRecord(run: WorkflowRunOf<typeof call>): CallRecord {
  if (run.status === "completed") return run.output;
  const base = {
    id: run.key ?? run.runId,
    phone_number: run.label ?? "",
    created_at: run.createdAt,
    transcript: [],
  };
  if (run.status === "failed") return { ...base, status: "failed", error: run.error };
  if (run.status === "cancelled") return { ...base, status: "completed", outcome: "canceled" };
  return { ...base, status: "queued", summary: describeRun(call, run) };
}

/** `POST /v1/calls` — validate, start the run, answer at once. */
export const createCall = apiKeyRoute(
  AUTH,
  route({
    body: callRequest,
    handler: async (req, ctx) => {
      const id = newCallId();
      const createdAt = Date.now();
      await ctx.workflows.start(
        call,
        { ...req.body, id, created_at: createdAt },
        // `key` is how every later read finds the run; `label` carries the number
        // so an unfinished run can still say who it is calling.
        { key: id, label: req.body.phone_number },
      );
      const record: CallRecord = {
        id,
        status: "queued",
        phone_number: req.body.phone_number,
        created_at: createdAt,
        transcript: [],
      };
      return routeResponse(201, record);
    },
  }),
);

/** `GET /v1/calls/:id` — the call as it stands. */
export const getCall = apiKeyRoute(AUTH, async (req, ctx) => {
  const id = req.params.id ?? "";
  const [run] = await ctx.workflows.find(call, id, { limit: 1 });
  if (run === undefined) throw routeError(404, `No call ${id}.`);
  return toRecord(run);
});

/** `GET /v1/calls` — the most recent calls, newest first. */
export const listCalls = apiKeyRoute(AUTH, async (_req, ctx) => {
  const runs = await ctx.workflows.recent(call, { limit: LIST_LIMIT });
  const list: CallList = { calls: runs.map(toRecord) };
  return list;
});
