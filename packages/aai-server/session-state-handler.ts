// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/session-state` — the guest's session slots and event log.
 *
 * Turn-level durability with no tenant database. The shape is the run-storage
 * route's, deliberately: `{ method, args }` behind one bearer check, because the
 * alternative is six routes and six places to restate the same scoping.
 *
 * ## The scoping is simpler than run storage's, and the schema is why
 *
 * `workflow-storage-handler.ts` needs a per-method table because the DevKit's
 * schema has no tenant column, so five of its eleven methods are keyed by
 * something that is not a run. Here the slug is part of the primary key and part of
 * every statement (`platform-session-state.ts`), so the boundary is the SLUG
 * ARGUMENT — taken from the bearer, never from the request. There is nothing per
 * method to decide, and nothing to forget.
 *
 * A guessed session id therefore reaches nothing: no statement in the store can be
 * pointed at another agent's rows.
 */

import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { isOneOf, requiredInt, requiredString } from "./_body-fields.ts";
import type { AppContext } from "./context.ts";
import { assertGuestBearer } from "./guest-bearer.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import {
  appendEvents,
  commitSlots,
  discardSession,
  loadSlots,
  nextEventIndex,
  type PlatformSessionEvent,
  readEvents,
} from "./platform-session-state.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("session.state");

/**
 * This route's own path under `/:slug`.
 *
 * From `PLATFORM_ROUTES`, not a literal: the guest client that CALLS this route
 * (`aai-runtime/platform-endpoint.ts`) is the other half of one wire, and a
 * literal on each side is a rename away from a 404 the runtime can only report as
 * `answered HTTP 404`. `aai-server` already imports that package's `/internal`;
 * the dependency does not run the other way, which is why the table lives there.
 */
export const SESSION_STATE_ROUTE = PLATFORM_ROUTES.sessionState;

/**
 * Cap on a request body.
 *
 * A commit carries the slots that changed, and the SDK's own per-slot cap bounds
 * each; retail mutates ~106 KB of state on a busy tool call, so 8 MiB is far above
 * every real flush and far below anything worth buffering on a route that writes to
 * the platform's database.
 */
export const MAX_SESSION_STATE_BODY_BYTES = 8_388_608;

/** Every method this route serves — the `SessionStateBackend` seam, minus its two flags. */
const METHODS = ["load", "commit", "discard", "appendEvents", "readEvents", "countEvents"] as const;

type Method = (typeof METHODS)[number];

function isMethod(value: unknown): value is Method {
  return isOneOf(METHODS, value);
}

/** `{ slot: value }`, every value a string. */
function slotMap(body: Record<string, unknown>): Record<string, string> {
  const values = body.values;
  if (!isRecord(values) || Object.values(values).some((v) => typeof v !== "string")) {
    throw new HTTPException(400, { message: "values must be a map of strings" });
  }
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)]));
}

/** The events to append, each carrying the index assigned above the backend. */
function eventList(body: Record<string, unknown>): PlatformSessionEvent[] {
  const events = body.events;
  if (!Array.isArray(events)) {
    throw new HTTPException(400, { message: "events must be an array" });
  }
  return events.map((entry) => {
    if (!isRecord(entry) || typeof entry.event !== "string" || !Number.isInteger(entry.index)) {
      throw new HTTPException(400, { message: "each event needs an integer index and a string" });
    }
    return { index: Number(entry.index), event: entry.event };
  });
}

export type SessionStateHandlerOptions = { adminDb?: AdminDb | undefined };

/**
 * Build the session-state handler.
 *
 * @internal
 */
export function createSessionStateHandler(
  opts: SessionStateHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = c.var.slug;
    await assertGuestBearer(c, slug);
    const adminDb = opts.adminDb;
    if (!adminDb) {
      // 501, like the enqueue and storage routes: there is no platform session
      // state on this deployment and a retry will not make one. A guest reading
      // this falls back to memory and SAYS so, rather than retrying forever.
      throw new HTTPException(501, { message: "platform session state not configured" });
    }

    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isRecord(body)) throw new HTTPException(400, { message: "body must be a JSON object" });
    if (!isMethod(body.method)) {
      // The value is not echoed: it is caller-supplied and this reply is a
      // tenant's to read.
      throw new HTTPException(400, { message: "unknown session-state method" });
    }
    const sessionId = requiredString(body, "sessionId");

    const reserved = await adminDb.reserve();
    const sql = (q: string, p?: unknown[]) => reserved.query(q, p);
    try {
      return c.json({ result: await serve(body.method, { sql, slug, sessionId }, body) }, 200);
    } catch (err: unknown) {
      if (err instanceof HTTPException) throw err;
      log.warn("session-state call failed", {
        slug,
        method: body.method,
        error: errorMessage(err),
      });
      // 503: every remaining cause is transient from the guest's point of view, and
      // the runtime's own flush already logs rather than failing the tool call.
      throw new HTTPException(503, { message: "session-state call failed", cause: err });
    } finally {
      reserved.release();
    }
  };
}

type Ctx = {
  sql: SqlExec;
  slug: string;
  sessionId: string;
};

/** Dispatch one call. The slug comes from `ctx`, never from the body. */
async function serve(method: Method, ctx: Ctx, body: Record<string, unknown>): Promise<unknown> {
  const { sql, slug, sessionId } = ctx;
  switch (method) {
    case "load":
      return loadSlots(sql, slug, sessionId);
    case "commit":
      await commitSlots(sql, slug, sessionId, slotMap(body));
      return null;
    case "discard":
      await discardSession(sql, slug, sessionId);
      return null;
    case "appendEvents":
      await appendEvents(sql, slug, sessionId, eventList(body));
      return null;
    case "readEvents":
      return readEvents(
        sql,
        slug,
        sessionId,
        requiredInt(body, "startIndex"),
        requiredInt(body, "limit"),
      );
    case "countEvents":
      return nextEventIndex(sql, slug, sessionId);
    default: {
      // Unreachable: the six arms above exhaust `Method`, and this ASSIGNMENT is
      // what keeps that true. `countEvents` used to live in this arm, which meant a
      // seventh `METHODS` entry compiled clean and silently answered with the event
      // count; now it stops compiling here. The arm exists because biome's
      // `useDefaultSwitchClause` wants one, not because a call can reach it —
      // `isMethod` has already refused anything else with a 400.
      const unreachable: never = method;
      throw new HTTPException(400, { message: `unknown method ${String(unreachable)}` });
    }
  }
}
