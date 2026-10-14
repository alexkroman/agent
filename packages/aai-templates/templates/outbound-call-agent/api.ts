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
 * | `GET /v1/calls/:id` | the call as it stands: live lines while it is talking, the full record once done |
 * | `GET /v1/calls` | the most recent calls, newest first |
 *
 * Every route checks `Authorization` against `CALLS_API_KEY` (a bare key or
 * `Bearer <key>`): `agent({ routes })` is as open as the server, and a route
 * that dials a phone is not one to leave open.
 *
 * Each call is one run of the `call` workflow, started with `key` = the call
 * id, so the API stores nothing of its own: a read is `find(call, id)`.
 */

import {
  type RouteContext,
  type RouteHandler,
  type RouteRequest,
  routeError,
  routeResponse,
} from "@alexkroman1/aai";
import type { WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import type { CallList, CallRecord } from "./api-types.ts";
import { safeEqual } from "./call-params.ts";
import { liveCall } from "./live-calls.ts";
import { call, callRequest } from "./shared.ts";

/** Most calls `GET /v1/calls` lists. */
export const LIST_LIMIT = 50;

/** Refuse a request that does not carry `CALLS_API_KEY`. */
export function authorize(req: RouteRequest, env: RouteContext["env"]): void {
  const key = env.CALLS_API_KEY;
  if (!key)
    throw routeError(503, "The calls API is off: set the CALLS_API_KEY secret to turn it on.");
  const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!safeEqual(given, key)) throw routeError(401, "Missing or wrong Authorization header.");
}

/** A fresh call id: `call_` and sixteen random hex characters. */
export function newCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * What a run says about its call. A finished run's output IS the record; an
 * unfinished one is filled in from the live transcript when this process is
 * the one on the call.
 */
export function toRecord(run: WorkflowRunSnapshot<CallRecord>): CallRecord {
  const id = run.key ?? run.runId;
  const base = { id, phone_number: run.label ?? "", created_at: run.createdAt, transcript: [] };
  switch (run.status) {
    case "completed":
      return run.output;
    case "failed":
      return { ...base, status: "failed", error: run.error };
    case "cancelled":
      return { ...base, status: "completed", outcome: "canceled" };
    default: {
      const live = liveCall(id);
      return live === undefined
        ? { ...base, status: "queued" }
        : { ...base, status: "in-progress", transcript: [...live.transcript] };
    }
  }
}

/** `POST /v1/calls` — validate, start the run, answer at once. */
export const createCall: RouteHandler = async (req, ctx) => {
  authorize(req, ctx.env);
  const parsed = callRequest.safeParse(req.body);
  if (!parsed.success) {
    throw routeError(400, parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const id = newCallId();
  const createdAt = Date.now();
  await ctx.workflows.start(
    call,
    { ...parsed.data, id, created_at: createdAt },
    // `key` is how every later read finds the run; `label` carries the number
    // so an unfinished run can still say who it is calling.
    { key: id, label: parsed.data.phone_number },
  );
  const record: CallRecord = {
    id,
    status: "queued",
    phone_number: parsed.data.phone_number,
    created_at: createdAt,
    transcript: [],
  };
  return routeResponse(201, record);
};

/** `GET /v1/calls/:id` — the call as it stands. */
export const getCall: RouteHandler = async (req, ctx) => {
  authorize(req, ctx.env);
  const id = req.params.id ?? "";
  const [run] = await ctx.workflows.find(call, id, { limit: 1 });
  if (run === undefined) throw routeError(404, `No call ${id}.`);
  return toRecord(run);
};

/** `GET /v1/calls` — the most recent calls, newest first. */
export const listCalls: RouteHandler = async (req, ctx) => {
  authorize(req, ctx.env);
  const runs = await ctx.workflows.recent(call, { limit: LIST_LIMIT });
  const list: CallList = { calls: runs.map(toRecord) };
  return list;
};
