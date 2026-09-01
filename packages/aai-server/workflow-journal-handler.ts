// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-journal` — the replay engine's journal for a deployed run.
 *
 * The shape is `session-state-handler.ts`'s, and for the same reason: twelve
 * methods behind one bearer check, because the alternative is twelve routes and
 * twelve places to restate the same scoping.
 *
 * ## What it closes
 *
 * A durable run's whole claim is that it outlives the process running it. The
 * engine has three journal backends and, before this route, a deployed guest could
 * reach neither durable one — the Postgres store needs a `DATABASE_URL` and the
 * platform provisions no tenant database, so every deployed run journaled into a
 * `Map` inside a sandbox that self-exits after `AGENT_IDLE_EXIT_MS`. The run then
 * never resumed, and reported nothing: from inside the system, a step whose result
 * was lost and a step that was never reached look identical.
 *
 * ## The scoping needs no per-method table
 *
 * `workflow-storage-handler.ts` needs one because the DevKit's schema has no
 * tenant column, so five of its eleven methods are keyed by something that is not
 * a run. Here the slug is part of every primary key and every statement
 * (`platform-workflow-journal.ts`), and it is taken from the BEARER, never from
 * the request. There is nothing per method to decide and nothing to forget: a
 * guessed run id reaches no row, and a guessed hook token reaches no window.
 *
 * @internal
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { isOneOf, optionalString, requiredInt, requiredString } from "./_body-fields.ts";
import { guestSlug, notConfigured, withReserved } from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import * as journal from "./platform-workflow-journal.ts";
import type { SqlExec } from "./secret-store.ts";

const log = createLogger("workflow.journal");

/**
 * This route's own path under `/:slug`.
 *
 * From `PLATFORM_ROUTES`, not a literal: the guest client that CALLS it is the
 * other half of one wire, and a literal on each side is a rename away from a 404
 * the runtime can only report as `answered HTTP 404`.
 */
export const WORKFLOW_JOURNAL_ROUTE = PLATFORM_ROUTES.workflowJournal;

/**
 * Cap on a request body.
 *
 * A journal write carries one step's output or one run's input, both of which are
 * an author's own values — far smaller than an upload window and far larger than
 * any realistic step result. The same 8 MiB as session state, for the same reason:
 * above every real write, below anything worth buffering on a route that writes to
 * the platform's database.
 */
export const MAX_WORKFLOW_JOURNAL_BODY_BYTES = 8_388_608;

/** Every method this route serves — the `JournalStore` seam. */
const METHODS = [
  "createRun",
  "getRun",
  "listRuns",
  "setStatus",
  "readSteps",
  "claimAttempt",
  "claimSleep",
  "wakeSleeps",
  "claimHook",
  "closeHook",
  "deliverHook",
  "appendStep",
] as const;

type Method = (typeof METHODS)[number];

function isMethod(value: unknown): value is Method {
  return isOneOf(METHODS, value);
}

/** A list of strings, or undefined when the key is absent. */
function optionalStrings(
  body: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HTTPException(400, { message: `${key} must be an array of strings` });
  }
  return value.map(String);
}

/** One step entry, as the engine writes it. */
function stepEntry(body: Record<string, unknown>): journal.JournalStepRow {
  const record = body.entry;
  if (!isRecord(record)) {
    throw new HTTPException(400, { message: "entry must be an object" });
  }
  return {
    key: requiredString(record, "key"),
    name: requiredString(record, "name"),
    status: requiredString(record, "status"),
    output: optionalString(record, "output"),
    error: optionalString(record, "error"),
    attempts: requiredInt(record, "attempts"),
    finishedAt: requiredInt(record, "finishedAt"),
  };
}

export type WorkflowJournalHandlerOptions = { adminDb?: AdminDb | undefined };

/**
 * Build the workflow-journal handler.
 *
 * @internal
 */
export function createWorkflowJournalHandler(
  opts: WorkflowJournalHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = await guestSlug(c);
    const adminDb = opts.adminDb;
    // 501, like the enqueue, storage and session-state routes: there is no
    // platform journal on this deployment and a retry will not make one. Terminal
    // for the guest, whose backend is chosen once at construction — see
    // `notConfigured` for why that is described rather than papered over with a
    // fallback, which here would silently return a run to memory.
    if (!adminDb) throw notConfigured("platform workflow journal");

    const fields: unknown = await c.req.json().catch(() => undefined);
    if (!isRecord(fields)) {
      throw new HTTPException(400, { message: "body must be a JSON object" });
    }
    if (!isMethod(fields.method)) {
      // The value is not echoed: it is caller-supplied and this reply is a
      // tenant's to read.
      throw new HTTPException(400, { message: "unknown workflow-journal method" });
    }
    const method = fields.method;

    return await withReserved(
      adminDb,
      { log, failure: "workflow-journal call failed", detail: { slug, method } },
      async (sql) => c.json({ result: await serve(method, { sql, slug }, fields) }, 200),
    );
  };
}

type Ctx = { sql: SqlExec; slug: string };

/** Dispatch one call. The slug comes from `ctx`, never from the body. */
async function serve(method: Method, ctx: Ctx, body: Record<string, unknown>): Promise<unknown> {
  const { sql, slug } = ctx;
  switch (method) {
    case "createRun":
      await journal.createRun(sql, slug, {
        runId: requiredString(body, "runId"),
        workflow: requiredString(body, "workflow"),
        status: requiredString(body, "status"),
        createdAt: requiredInt(body, "createdAt"),
        input: optionalString(body, "input"),
      });
      return null;
    case "getRun":
      return (await journal.getRun(sql, slug, requiredString(body, "runId"))) ?? null;
    case "listRuns":
      return journal.listRuns(
        sql,
        slug,
        requiredString(body, "workflow"),
        requiredInt(body, "limit"),
      );
    case "setStatus":
      return journal.setStatus(
        sql,
        slug,
        requiredString(body, "runId"),
        requiredString(body, "status"),
        { output: optionalString(body, "output"), error: optionalString(body, "error") },
        optionalStrings(body, "expect"),
      );
    case "readSteps":
      return journal.readSteps(sql, slug, requiredString(body, "runId"));
    case "claimAttempt":
      return journal.claimAttempt(
        sql,
        slug,
        requiredString(body, "runId"),
        requiredString(body, "key"),
      );
    case "claimSleep":
      return journal.claimSleep(
        sql,
        slug,
        requiredString(body, "runId"),
        requiredString(body, "key"),
        requiredInt(body, "wakeAt"),
        optionalString(body, "correlationId"),
        requiredString(body, "kind"),
      );
    case "wakeSleeps":
      return journal.wakeSleeps(
        sql,
        slug,
        requiredString(body, "runId"),
        requiredInt(body, "now"),
        optionalStrings(body, "correlationIds"),
      );
    case "claimHook":
      return journal.claimHook(
        sql,
        slug,
        requiredString(body, "runId"),
        requiredString(body, "key"),
        requiredString(body, "token"),
      );
    case "closeHook":
      await journal.closeHook(
        sql,
        slug,
        requiredString(body, "runId"),
        requiredString(body, "key"),
      );
      return null;
    case "deliverHook":
      return (
        (await journal.deliverHook(
          sql,
          slug,
          requiredString(body, "token"),
          optionalString(body, "payload"),
        )) ?? null
      );
    case "appendStep":
      return journal.appendStep(sql, slug, requiredString(body, "runId"), stepEntry(body));
    default: {
      // Unreachable: the arms above exhaust `Method`, and this ASSIGNMENT is what
      // keeps that true — a thirteenth `METHODS` entry stops compiling here rather
      // than compiling clean and answering with whatever the last arm returned.
      // The arm exists because biome's `useDefaultSwitchClause` wants one, not
      // because a call can reach it: `isMethod` has already refused anything else
      // with a 400.
      const unreachable: never = method;
      throw new HTTPException(400, { message: `unknown method ${String(unreachable)}` });
    }
  }
}
