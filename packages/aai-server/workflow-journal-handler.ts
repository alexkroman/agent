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
import {
  isOneOf,
  optionalInt,
  optionalString,
  requiredInt,
  requiredSize,
  requiredString,
} from "./_body-fields.ts";
import { guestSlug, notConfigured, type PlatformCall, withReserved } from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import * as journal from "./platform-workflow-journal.ts";

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

/**
 * Cap on how many runs one `listRuns` may answer with.
 *
 * The body cap above bounds what a caller SENDS on this route; nothing bounded
 * what it gets back, and `limit` went straight into `LIMIT $3`. That asymmetry is
 * the defect: one token-holder could seed runs, ask for all of them at once, and
 * make a SHARED replica buffer the whole result set on one of `ADMIN_POOL_MAX`
 * reserved connections and serialize it into a single JSON body — one tenant
 * deciding another tenant's replica memory. A negative limit was worse than
 * useless: it reached Postgres as `LIMIT -1` and came back as a 503, telling the
 * guest to retry a request that can never succeed.
 *
 * ## Why 100, and why it is not a round number picked by feel
 *
 * It is the largest value a conforming caller can produce. Every SDK path into
 * this route goes through `WorkflowClient.find`/`recent`, which clamp with
 * `resolveFindLimit` to `MAX_WORKFLOW_FIND_LIMIT` — so 100 really does arrive
 * here, and anything above it is a client that has been bypassed. That fixes the
 * number from both directions: lower would 400 a request the shipped client
 * makes, and higher is headroom nothing real reaches, which is a bound that
 * cannot be observed to work. `workflow-journal-handler.test.ts` pins the two
 * equal, so raising either side is a decision the other is owed.
 *
 * What it costs at the ceiling: a listing row is the run's identity plus its
 * `input` and `output`, so a hundred of them is ordinarily on the order of a
 * megabyte, and four concurrent listings — `ADMIN_POOL_MAX` — a few megabytes,
 * the same order as the single-request body cap above. A UI is nowhere near it:
 * `DEFAULT_WORKFLOW_FIND_LIMIT` is 20, so this is five pages.
 *
 * What it does NOT bound is BYTES. A run's `input` and `output` are capped only
 * by the body cap above, so a hundred rows of 8 MiB inputs is still a large
 * answer. Bounding that means the store returning a truncated page, which is a
 * change to the `JournalStore` contract rather than to this route.
 */
export const MAX_WORKFLOW_JOURNAL_LIST_LIMIT = 100;

/** Every method this route serves — the `JournalStore` seam. */
const METHODS = [
  "createRun",
  "getRun",
  "listRuns",
  "setStatus",
  "readSteps",
  "readStep",
  "claimAttempt",
  "releaseAttempt",
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

/**
 * A `listRuns` page size, refused rather than clamped when it is out of range.
 *
 * REFUSED, because this is not the boundary a human types a URL into: the only
 * caller is another of our own processes, whose client already clamps to the same
 * ceiling, so an out-of-range value here is a bug or a bypass and there is nobody
 * to be friendly to. Clamping would answer it with a page that looks complete and
 * is not — see {@link MAX_WORKFLOW_JOURNAL_LIST_LIMIT}. The edge that DOES face a
 * human, `GET /workflows/runs` in `aai-runtime/workflow-api-runs.ts`, clamps and
 * says in the reply that it did.
 *
 * {@link requiredSize} carries the non-integer and negative halves — a negative
 * limit is exactly the one that used to reach Postgres as `LIMIT -1` and surface
 * as a retryable 503 — and the range is what is left. Zero is refused with them:
 * no conforming client sends one, and an empty page is not an answer anybody
 * asked for.
 */
function listLimit(body: Record<string, unknown>): number {
  const limit = requiredSize(body, "limit");
  if (limit < 1 || limit > MAX_WORKFLOW_JOURNAL_LIST_LIMIT) {
    throw new HTTPException(400, {
      message: `limit must be between 1 and ${MAX_WORKFLOW_JOURNAL_LIST_LIMIT}`,
    });
  }
  return limit;
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
    // OPTIONAL, unlike every field above it: the column was added to a table
    // that already held rows, so an engine older than it sends nothing and an
    // absent start is the honest answer. See `StepEntry.startedAt`.
    startedAt: optionalInt(record, "startedAt"),
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
    // Read BEFORE the reservation: a body this route is going to refuse must not
    // take an admin connection to be refused. See `PlatformCall`.
    const call = plan(method, slug, fields);

    return await withReserved(
      adminDb,
      {
        log,
        failure: "workflow-journal call failed",
        detail: { slug, method },
        // 409 and NOT logged as a failure: a refused hook-token claim, and a
        // refused duplicate run id, are this route WORKING. The generic arm below
        // is a 503, which tells the guest to retry a condition that cannot change
        // — the holder is alive, the run id exists — so the engine burned the
        // message's attempt budget on it instead of failing the run. The message
        // names the cause, where `workflow-journal call failed` could not.
        //
        // Both are the same shape of answer and take the same status: a
        // caller-supplied identifier is taken. That is what the upload record
        // route's `claim` 409 already means, and 409 rather than 400 because the
        // request is well formed — nothing about it can be corrected by sending
        // it differently.
        statusFor: (err) =>
          err instanceof journal.PlatformWorkflowHookTokenError ||
          err instanceof journal.PlatformWorkflowRunTakenError
            ? new HTTPException(409, { message: err.message, cause: err })
            : undefined,
      },
      async (sql) => c.json({ result: await call(sql) }, 200),
    );
  };
}

/**
 * Read one call's fields and return the work that needs a connection.
 *
 * The slug is the BEARER's, never the body's. Every `requiredString`,
 * `requiredInt`, `listLimit`, `optionalStrings` and `stepEntry` below runs HERE —
 * outside `withReserved` — which is the whole point of the shape: see
 * `PlatformCall`. Thirteen arms, so the discipline is worth stating: an arm reads
 * its fields into locals and the returned closure names only those, never `body`.
 */
function plan(method: Method, slug: string, body: Record<string, unknown>): PlatformCall {
  switch (method) {
    case "createRun": {
      const run = {
        runId: requiredString(body, "runId"),
        workflow: requiredString(body, "workflow"),
        status: requiredString(body, "status"),
        createdAt: requiredInt(body, "createdAt"),
        input: optionalString(body, "input"),
        codeVersion: optionalString(body, "codeVersion"),
      };
      return async (sql) => {
        await journal.createRun(sql, slug, run);
        return null;
      };
    }
    case "getRun": {
      const runId = requiredString(body, "runId");
      return async (sql) => (await journal.getRun(sql, slug, runId)) ?? null;
    }
    case "listRuns": {
      const workflow = requiredString(body, "workflow");
      const limit = listLimit(body);
      return (sql) => journal.listRuns(sql, slug, workflow, limit);
    }
    case "setStatus": {
      const runId = requiredString(body, "runId");
      const status = requiredString(body, "status");
      const result = {
        output: optionalString(body, "output"),
        error: optionalString(body, "error"),
      };
      const expect = optionalStrings(body, "expect");
      return (sql) => journal.setStatus(sql, slug, runId, status, result, expect);
    }
    case "readSteps": {
      const runId = requiredString(body, "runId");
      return (sql) => journal.readSteps(sql, slug, runId);
    }
    case "readStep": {
      const runId = requiredString(body, "runId");
      const key = requiredString(body, "key");
      return (sql) => journal.readStep(sql, slug, runId, key);
    }
    case "claimAttempt": {
      const runId = requiredString(body, "runId");
      const key = requiredString(body, "key");
      return (sql) => journal.claimAttempt(sql, slug, runId, key);
    }
    case "releaseAttempt": {
      const runId = requiredString(body, "runId");
      const key = requiredString(body, "key");
      return (sql) => journal.releaseAttempt(sql, slug, runId, key);
    }
    case "claimSleep": {
      const runId = requiredString(body, "runId");
      const key = requiredString(body, "key");
      const wakeAt = requiredInt(body, "wakeAt");
      const correlationId = optionalString(body, "correlationId");
      const kind = requiredString(body, "kind");
      return (sql) => journal.claimSleep(sql, slug, runId, key, wakeAt, correlationId, kind);
    }
    case "wakeSleeps": {
      const runId = requiredString(body, "runId");
      const now = requiredInt(body, "now");
      const correlationIds = optionalStrings(body, "correlationIds");
      return (sql) => journal.wakeSleeps(sql, slug, runId, now, correlationIds);
    }
    case "claimHook": {
      const runId = requiredString(body, "runId");
      const key = requiredString(body, "key");
      const token = requiredString(body, "token");
      return (sql) => journal.claimHook(sql, slug, runId, key, token);
    }
    case "closeHook": {
      const runId = requiredString(body, "runId");
      const key = requiredString(body, "key");
      // The BOOLEAN, not `null`: it is a compare-and-set now, and its answer is
      // what decides whether the guest's body takes the timed-out branch or the
      // answered one.
      return (sql) => journal.closeHook(sql, slug, runId, key);
    }
    case "deliverHook": {
      const token = requiredString(body, "token");
      const payload = optionalString(body, "payload");
      return async (sql) => (await journal.deliverHook(sql, slug, token, payload)) ?? null;
    }
    case "appendStep": {
      const runId = requiredString(body, "runId");
      const entry = stepEntry(body);
      return (sql) => journal.appendStep(sql, slug, runId, entry);
    }
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
