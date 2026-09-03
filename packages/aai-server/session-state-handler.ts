// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/session-state` — the guest's session slots and event log.
 *
 * Turn-level durability with no tenant database. The shape it shares with its
 * three sibling platform routes is deliberate: `{ method, args }` behind one
 * bearer check, because the alternative is six routes and six places to restate
 * the same scoping.
 *
 * ## The scoping is a SCHEMA property, not a per-method table
 *
 * The slug is part of the primary key and part of every statement
 * (`platform-session-state.ts`), so the boundary is the SLUG ARGUMENT — taken
 * from the bearer, never from the request. There is nothing per method to
 * decide, and nothing to forget. The DevKit's run-storage route was the
 * counter-example and is the reason this is worth stating: its schema had no
 * tenant column, so five of its eleven methods were keyed by something that was
 * not a run and each needed its own scoping rule. That route is gone;
 * `workflow-journal-handler.ts` replaced it, with the slug in every key.
 *
 * A guessed session id therefore reaches nothing: no statement in the store can be
 * pointed at another agent's rows.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { isOneOf, requiredInt, requiredString } from "./_body-fields.ts";
import {
  guestSlug,
  guestTrace,
  notConfigured,
  type PlatformCall,
  withReserved,
} from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
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
    const slug = await guestSlug(c);
    const adminDb = opts.adminDb;
    // 501, like the enqueue and storage routes: there is no platform session state
    // on this deployment and a retry will not make one. TERMINAL for the guest —
    // its backend is chosen once at construction, so this fails the call, which
    // for session state is `hydrate`. See `notConfigured` for why that is
    // described rather than fixed with a fallback.
    if (!adminDb) throw notConfigured("platform session state");

    const body: unknown = await c.req.json().catch(() => undefined);
    if (!isRecord(body)) throw new HTTPException(400, { message: "body must be a JSON object" });
    if (!isMethod(body.method)) {
      // The value is not echoed: it is caller-supplied and this reply is a
      // tenant's to read.
      throw new HTTPException(400, { message: "unknown session-state method" });
    }
    const method = body.method;
    const sessionId = requiredString(body, "sessionId");
    // Read BEFORE the reservation: a body this route is going to refuse must not
    // take an admin connection to be refused. See `PlatformCall`.
    const call = plan(method, { slug, sessionId }, body);

    return await withReserved(
      adminDb,
      { log, failure: "session-state call failed", detail: { slug, method }, trace: guestTrace(c) },
      async (sql) => c.json({ result: await call(sql) }, 200),
    );
  };
}

type Ctx = {
  slug: string;
  sessionId: string;
};

/**
 * Read one call's fields and return the work that needs a connection.
 *
 * The slug comes from `ctx`, never from the body. Every `requiredInt`, `slotMap`
 * and `eventList` below runs HERE — outside `withReserved` — which is the whole
 * point of the shape: see `PlatformCall`.
 */
function plan(method: Method, ctx: Ctx, body: Record<string, unknown>): PlatformCall {
  const { slug, sessionId } = ctx;
  switch (method) {
    case "load":
      return (sql) => loadSlots(sql, slug, sessionId);
    case "commit": {
      const values = slotMap(body);
      return async (sql) => {
        await commitSlots(sql, slug, sessionId, values);
        return null;
      };
    }
    case "discard":
      return async (sql) => {
        await discardSession(sql, slug, sessionId);
        return null;
      };
    case "appendEvents": {
      const events = eventList(body);
      return async (sql) => {
        await appendEvents(sql, slug, sessionId, events);
        return null;
      };
    }
    case "readEvents": {
      const startIndex = requiredInt(body, "startIndex");
      const limit = requiredInt(body, "limit");
      return (sql) => readEvents(sql, slug, sessionId, startIndex, limit);
    }
    case "countEvents":
      return (sql) => nextEventIndex(sql, slug, sessionId);
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
