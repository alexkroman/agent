// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-keys` — the correlation-key index for a deployed run.
 *
 * The shape is `workflow-journal-handler.ts`'s and `session-state-handler.ts`'s:
 * methods behind one bearer check, because the alternative is a route per method
 * and a place per route to restate the same scoping. Two methods here, `record`
 * and `lookup`, which is the whole `WorkflowKeyStore` interface.
 *
 * ## What it closes
 *
 * `(workflow, key) -> runId` is how a caller's next call finds the durable run
 * their last one started, and it is the pointer the whole `StartOptions.key` /
 * `WorkflowClient.find` feature is. The index had two backends and a deployed
 * guest could reach neither durable one: `createPostgresKeyStore` needs a
 * `DATABASE_URL` and the platform provisions no tenant database, so
 * `resolveKeyStore` fell to a `Map` in a sandbox that self-exits after
 * `AGENT_IDLE_EXIT_MS`.
 *
 * That is the journal's bug one table over, with a nastier symptom, because the
 * journal is durable now: the RUN outlived the sandbox and the only pointer to it
 * did not, so `find()` answered `[]` on the caller's next call and the agent
 * started a second run for somebody it had already served. Nothing reported it —
 * an empty index and a first-time caller are the same answer — and the boot line
 * printed `keyStore: "memory"` with nobody reading it.
 *
 * ## The scoping needs no per-method table
 *
 * The slug leads the primary key and is the first parameter of both statements
 * (`platform-workflow-keys.ts`), and it comes from the BEARER rather than from the
 * request. There is nothing per method to decide and nothing to forget: a guessed
 * run id reaches nothing, and a lookup cannot be pointed at another agent's rows.
 *
 * @internal
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { PLATFORM_ROUTES } from "@alexkroman1/aai-runtime/internal";
import { HTTPException } from "hono/http-exception";
import { isOneOf, requiredInt, requiredSize, requiredString } from "./_body-fields.ts";
import { guestSlug, notConfigured, type PlatformCall, withReserved } from "./_platform-route.ts";
import type { AppContext } from "./context.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import * as keys from "./platform-workflow-keys.ts";

const log = createLogger("workflow.keys");

/**
 * This route's own path under `/:slug`.
 *
 * From `PLATFORM_ROUTES`, not a literal: the guest client that CALLS it
 * (`aai-runtime/workflow-keys-platform.ts`) is the other half of one wire, and a
 * literal on each side is a rename away from a 404 the runtime can only report as
 * `answered HTTP 404` — i.e. a `find` that answers nothing, which is
 * indistinguishable from a caller with no prior run.
 */
export const WORKFLOW_KEYS_ROUTE = PLATFORM_ROUTES.workflowKeys;

/**
 * Cap on a request body.
 *
 * Far smaller than the journal's 8 MiB, because nothing author-sized crosses this
 * route: a `record` carries two names, a run id and a number, and a `lookup`
 * carries two names and a limit. A correlation key is a phone number, an order id
 * or a session id — `StartOptions.key`'s own doc — so 64 KiB is orders of
 * magnitude above every real call and still below anything worth buffering on a
 * route that writes to the platform's database. It is a body cap rather than a
 * per-field length: the fields are stored in `text` columns with no declared
 * bound, and one number bounding the whole request is one thing to reason about.
 */
export const MAX_WORKFLOW_KEYS_BODY_BYTES = 65_536;

/**
 * Cap on how many run ids one `lookup` may answer with.
 *
 * The body cap above bounds what a caller SENDS; without this nothing bounded
 * what it gets back, and `limit` went straight into `limit $4` — the same defect
 * `MAX_WORKFLOW_JOURNAL_LIST_LIMIT` was added for, on a route where the answer is
 * cheaper per row but the mechanism is identical: one token-holder seeding keys
 * and asking for all of them at once decides how much of a SHARED replica's
 * memory one of `ADMIN_POOL_MAX` reserved connections buffers.
 *
 * ## Why 100
 *
 * It is the largest value a conforming caller can produce. Every SDK path into
 * this route is `WorkflowClient.find`, which clamps with `resolveFindLimit` to
 * `MAX_WORKFLOW_FIND_LIMIT` — so 100 really does arrive here, and anything above
 * it is a client that has been bypassed. That fixes the number from both
 * directions: lower would 400 a request the shipped client makes, and higher is
 * headroom nothing real reaches, which is a bound that cannot be observed to
 * work. `workflow-keys-handler.test.ts` pins the two equal, so raising either
 * side is a decision the other is owed.
 */
export const MAX_WORKFLOW_KEY_LOOKUP_LIMIT = 100;

/** Every method this route serves — the `WorkflowKeyStore` seam. */
const METHODS = ["record", "lookup"] as const;

type Method = (typeof METHODS)[number];

function isMethod(value: unknown): value is Method {
  return isOneOf(METHODS, value);
}

/**
 * The correlation key: a required string that MAY be empty.
 *
 * NOT `requiredString`, which refuses `""` — and the empty key is reachable
 * rather than theoretical. `StartOptions.key` is author-supplied and the obvious
 * source for a voice agent is the caller's number, which is empty for a withheld
 * caller ID; both other backends treat `""` as an ordinary key, and the shared
 * conformance case "an EMPTY key is a key, not absence" says so. A 400 here would
 * make this the one backend that refuses what the other two store, which is the
 * divergence class that table exists to prevent.
 *
 * ABSENT is still a 400, which is why this is not `optionalString(…) ?? ""`: a
 * client that forgot the field would then index every one of its runs under one
 * bucket that reads back as absence.
 */
function keyField(body: Record<string, unknown>): string {
  const value = body.key;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: "key is required" });
  }
  return value;
}

/**
 * A `lookup` page size, refused rather than clamped when it is out of range.
 *
 * REFUSED for the reason the journal route's `listRuns` limit is: the only caller
 * is another of our own processes whose client already clamps to the same ceiling,
 * so an out-of-range value is a bug or a bypass and there is nobody to be
 * friendly to — where clamping would answer with a page that looks complete and
 * is not. `requiredSize` carries the non-integer and negative halves (a negative
 * limit is the one that reaches Postgres as `limit -1` and surfaces as a
 * retryable 503), and the range is what is left.
 *
 * ZERO is ACCEPTED here, and that is the one place this differs from the journal
 * route. `limit 0` is a promise the seam makes — the shared case "a limit of ZERO
 * answers an empty page, not everything" is asserted of all three backends,
 * because the alternative reading of 0 is "unlimited" and that would turn a clamp
 * bug above this seam into a full history scan. Refusing it would make this
 * backend answer 400 where the other two answer `[]`.
 */
function lookupLimit(body: Record<string, unknown>): number {
  const limit = requiredSize(body, "limit");
  if (limit > MAX_WORKFLOW_KEY_LOOKUP_LIMIT) {
    throw new HTTPException(400, {
      message: `limit must be at most ${MAX_WORKFLOW_KEY_LOOKUP_LIMIT}`,
    });
  }
  return limit;
}

export type WorkflowKeysHandlerOptions = { adminDb?: AdminDb | undefined };

/**
 * Build the workflow-keys handler.
 *
 * @internal
 */
export function createWorkflowKeysHandler(
  opts: WorkflowKeysHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = await guestSlug(c);
    const adminDb = opts.adminDb;
    // 501, like the journal, enqueue and session-state routes: there is no
    // platform index on this deployment and a retry will not make one. Terminal
    // for the guest, whose backend is chosen once at construction — see
    // `notConfigured` for why that is described rather than papered over with a
    // fallback, which here would silently return the index to memory.
    if (!adminDb) throw notConfigured("platform workflow keys");

    const fields: unknown = await c.req.json().catch(() => undefined);
    if (!isRecord(fields)) {
      throw new HTTPException(400, { message: "body must be a JSON object" });
    }
    if (!isMethod(fields.method)) {
      // The value is not echoed: it is caller-supplied and this reply is a
      // tenant's to read.
      throw new HTTPException(400, { message: "unknown workflow-keys method" });
    }
    const method = fields.method;
    // Read BEFORE the reservation: a body this route is going to refuse must not
    // take one of `ADMIN_POOL_MAX` connections to be refused. See `PlatformCall`.
    const call = plan(method, slug, fields);

    return await withReserved(
      adminDb,
      {
        log,
        failure: "workflow-keys call failed",
        detail: { slug, method },
        // No `statusFor`: neither method has a domain refusal. `record` is
        // idempotent by contract (`on conflict do nothing`) and `lookup` answers
        // an empty page for anything it does not hold, so every remaining failure
        // really is the store being unavailable — which is the 503 the generic arm
        // already answers.
      },
      async (sql) => c.json({ result: await call(sql) }, 200),
    );
  };
}

/**
 * Read one call's fields and return the work that needs a connection.
 *
 * The slug is the BEARER's, never the body's. Every field read below runs HERE —
 * outside `withReserved` — which is the whole point of the shape: see
 * `PlatformCall`. Each arm reads its fields into locals and the returned closure
 * names only those, never `body`.
 */
function plan(method: Method, slug: string, body: Record<string, unknown>): PlatformCall {
  switch (method) {
    case "record": {
      const entry = {
        runId: requiredString(body, "runId"),
        workflow: requiredString(body, "workflow"),
        key: keyField(body),
        // The ENGINE's clock, sent by the client, for the reason `wakeSleeps`'s
        // `now` is: the ordering this index promises is "the order they were
        // started", and a `now()` in the statement would be a second clock in it.
        createdAt: requiredInt(body, "createdAt"),
      };
      return (sql) => keys.recordKey(sql, slug, entry);
    }
    case "lookup": {
      const workflow = requiredString(body, "workflow");
      const key = keyField(body);
      const limit = lookupLimit(body);
      return (sql) => keys.lookupKey(sql, slug, workflow, key, limit);
    }
    default: {
      // Unreachable: the arms above exhaust `Method`, and this ASSIGNMENT is what
      // keeps that true — a third `METHODS` entry stops compiling here rather than
      // compiling clean and answering with whatever the last arm returned. The arm
      // exists because biome's `useDefaultSwitchClause` wants one, not because a
      // call can reach it: `isMethod` has already refused anything else with a 400.
      const unreachable: never = method;
      throw new HTTPException(400, { message: `unknown method ${String(unreachable)}` });
    }
  }
}
