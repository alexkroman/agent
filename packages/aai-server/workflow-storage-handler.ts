// Copyright 2026 the AAI authors. MIT license.
/**
 * `POST /:slug/workflow-storage` — the guest's Storage calls, scoped and forwarded.
 *
 * One route rather than eleven, and that is a decision about where the tenant check
 * lives. Eleven REST paths would mean eleven bearer checks and eleven places to
 * restate a scoping rule — and the dangerous mistake in this surface is forgetting
 * one. Here the bearer is checked once, `decideScope` classifies the call from a
 * closed table, and this function is the only thing that can reach the world.
 *
 * The request is `{ method, args }` and the reply is the DevKit's own return value.
 * The platform models neither: their params and entities are their business, and a
 * schema here would be a second copy of it to keep current.
 *
 * ## The four rules that are not "check a run id"
 *
 * `workflow-storage-scope.ts` explains why each method has the scope it has; this
 * is what those scopes DO:
 *
 * - `own-runs` (`runs.list`) is answered from the ownership table and `runs.get`,
 *   never forwarded — their list query filters on `workflowName` and `status`, so
 *   forwarding it would return every agent's runs.
 * - `filter-runs` (`events.listByCorrelationId`) is forwarded, then every result
 *   whose run this agent does not own is DROPPED. A correlation id is user-chosen,
 *   so two agents may legitimately pick the same one.
 * - `resolve-hook` (`hooks.get`, `hooks.getByToken`) fetches the hook, then checks
 *   the run it belongs to, and answers 404 when that fails — so a hook id or a
 *   token is not a way to learn about another agent's run.
 * - `create-run` (`events.create`) is the mutation. It may CREATE the run it is
 *   scoped by, so ownership is ESTABLISHED after the call rather than verified
 *   before it. See {@link scopeCreate}.
 *
 * ## Why a failed check is a 404 and not a 403
 *
 * "You do not own this run" and "there is no such run" have to be the same answer.
 * A 403 says a run id exists, which is the one bit a caller must not be able to
 * probe for — run ids are ULIDs, and their unguessability is only worth something
 * if nothing confirms a guess.
 */

import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { HTTPException } from "hono/http-exception";
import { constantTimeEquals } from "./_timing-safe.ts";
import type { AppContext } from "./context.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import type { AdminDb } from "./platform-lock.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import { claimRun, ownsRun, runIdsFor } from "./workflow-run-owner.ts";
import { decideScope, isStorageMethod, type StorageMethod } from "./workflow-storage-scope.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";

const log = createLogger("workflow.storage");

/** This route's own path under `/:slug`. */
export const WORKFLOW_STORAGE_ROUTE = "/workflow-storage";

/**
 * Cap on a storage request body.
 *
 * `events.create` carries a step's arguments or a run's output, which is the
 * largest thing on this surface. 4 MiB is well above every real one — a run with
 * a large payload uses the upload surface — and bounded well below anything worth
 * buffering on a route that writes to the platform's database.
 */
export const MAX_STORAGE_BODY_BYTES = 4_194_304;

/** How many runs `runs.list` answers with when the caller names no page size. */
const DEFAULT_RUN_PAGE = 50;

/** The most it will answer with, whatever the caller asks for. */
const MAX_RUN_PAGE = 500;

/** A minimal view of the DevKit members this route calls. */
type Callable = (...args: unknown[]) => Promise<unknown>;

/** `{ method, args }`, validated. */
type StorageCall = { method: StorageMethod; args: unknown[] };

function parseCall(raw: unknown): StorageCall {
  if (!isRecord(raw)) throw new HTTPException(400, { message: "body must be a JSON object" });
  if (!isStorageMethod(raw.method)) {
    // The value is NOT echoed. It is caller-supplied and this reply is a tenant's
    // to read, so naming the method set is the useful half without reflecting
    // input back.
    throw new HTTPException(400, { message: "unknown storage method" });
  }
  if (!Array.isArray(raw.args)) throw new HTTPException(400, { message: "args must be an array" });
  return { method: raw.method, args: raw.args };
}

/** The bearer this slug's running guest would hold, compared in constant time. */
async function assertGuestBearer(c: AppContext, slug: string): Promise<void> {
  const supplied = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (supplied === undefined || supplied === "") {
    throw new HTTPException(401, { message: "unauthorized" });
  }
  const version = await c.env.store.getAgentVersion(slug);
  if (version === null) throw new HTTPException(503, { message: "agent unavailable" });
  if (!constantTimeEquals(supplied, guestTokenFor(agentSandboxName(slug, version)))) {
    throw new HTTPException(401, { message: "unauthorized" });
  }
}

/**
 * Reach a dotted method on the storage handle.
 *
 * The members arrive typed `unknown` — `workflow-storage-world.ts` says why it does
 * not name the DevKit's `World` — so this narrows rather than casts through
 * `unknown`: a spread makes the keys strings, `isRecord` narrows the group, and the
 * `typeof` check is what licenses the one assertion. A double cast would have been
 * shorter and would stop reporting the moment their shape moves.
 */
function memberOf(storage: PlatformWorldStorage, method: StorageMethod): Callable {
  const [groupName, name] = method.split(".");
  const bag: Record<string, unknown> = { ...storage };
  const group = groupName === undefined ? undefined : bag[groupName];
  const fn = isRecord(group) && name !== undefined ? group[name] : undefined;
  if (typeof fn !== "function") {
    // Their shape moved. A 501 rather than a 500: this deployment cannot serve the
    // method, and no retry changes that.
    throw new HTTPException(501, { message: `storage method ${method} is unavailable` });
  }
  return fn as Callable;
}

/** The `runId` of a returned entity, when it has one. */
function entityRunId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["runId", "workflowRunId", "id"]) {
    const found = value[key];
    if (typeof found === "string" && found !== "") return found;
  }
  return undefined;
}

/** The `data` array of a paginated response, when the reply is one. */
function pageItems(value: unknown): unknown[] | undefined {
  if (!isRecord(value)) return undefined;
  return Array.isArray(value.data) ? value.data : undefined;
}

export type StorageHandlerOptions = {
  adminDb?: AdminDb | undefined;
  /** The platform's world, or undefined when there is no database behind it. */
  storage?: PlatformWorldStorage | undefined;
};

/**
 * Build the storage handler.
 *
 * @internal
 */
export function createWorkflowStorageHandler(
  opts: StorageHandlerOptions,
): (c: AppContext) => Promise<Response> {
  return async (c) => {
    const slug = c.var.slug;
    await assertGuestBearer(c, slug);
    const { adminDb, storage } = opts;
    if (!(adminDb && storage)) {
      // 501, like the enqueue route: there is no run storage on this deployment and
      // a retry will not make one.
      throw new HTTPException(501, { message: "platform run storage not configured" });
    }
    const call = parseCall(await c.req.json().catch(() => undefined));

    const reserved = await adminDb.reserve();
    const sql = (q: string, p?: unknown[]) => reserved.query(q, p);
    try {
      return c.json({ result: await serve(call, { slug, sql, storage }) }, 200);
    } catch (err: unknown) {
      if (err instanceof HTTPException) throw err;
      log.warn("storage call failed", { slug, method: call.method, error: errorMessage(err) });
      // 503: from the guest's point of view every remaining cause is transient (a
      // connection shortage, a partitioned database), and the DevKit retries the
      // step that was reading.
      throw new HTTPException(503, { message: "storage call failed", cause: err });
    } finally {
      reserved.release();
    }
  };
}

type ServeContext = {
  slug: string;
  sql: (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
  storage: PlatformWorldStorage;
};

/** Apply the call's scope, then forward it. */
async function serve(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const decision = decideScope(call.method, call.args);
  if (!decision.ok) throw new HTTPException(400, { message: decision.reason });

  // The one check every run-keyed method shares. 404, never 403 — see the module
  // doc: a 403 would confirm that a run id exists.
  if (decision.requiredRunId !== undefined) {
    if (!(await ownsRun(ctx.sql, decision.requiredRunId, ctx.slug))) {
      throw new HTTPException(404, { message: "no such run" });
    }
    return memberOf(ctx.storage, call.method)(...call.args);
  }

  switch (decision.scope.kind) {
    case "own-runs":
      return scopeOwnRuns(call, ctx);
    case "filter-runs":
      return scopeFilterRuns(call, ctx);
    case "resolve-hook":
      return scopeResolveHook(call, ctx);
    default:
      return scopeCreate(call, ctx);
  }
}

/**
 * `runs.list`, answered from the ownership table.
 *
 * Their query is NOT used: it filters on `workflowName` and `status` with no run
 * key, so forwarding it would list every agent's runs. This reads this agent's run
 * ids and fetches each, then applies the caller's filters itself.
 *
 * The cost is honest and worth stating: N+1 reads where their single query would
 * do, and a page derived from the ownership table's ordering rather than theirs.
 * A run list is a diagnostic surface — the studio's runs pane, `aai workflow list`
 * — not a hot path, and the alternative is a cross-tenant query.
 */
async function scopeOwnRuns(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const params = isRecord(call.args[0]) ? call.args[0] : {};
  const pagination = isRecord(params.pagination) ? params.pagination : {};
  const asked = typeof pagination.limit === "number" ? pagination.limit : DEFAULT_RUN_PAGE;
  const limit = Math.max(1, Math.min(MAX_RUN_PAGE, asked));

  const ids = await runIdsFor(ctx.sql, ctx.slug, limit);
  const get = memberOf(ctx.storage, "runs.get");
  const runs = await Promise.all(
    ids.map((id) =>
      // A run whose ownership row outlived its journal answers undefined rather
      // than failing the whole list — one missing run must not blank the pane.
      get(id, params).catch(() => undefined),
    ),
  );
  const wanted = runs.filter((run) => run !== undefined).filter((run) => matches(run, params));
  // Their own reply shape, so the guest's client needs no special case: a
  // paginated response with the items and no cursor.
  return { data: wanted, pagination: { hasMore: false } };
}

/** Does a run satisfy the caller's `workflowName` / `status` filters? */
function matches(run: unknown, params: Record<string, unknown>): boolean {
  if (!isRecord(run)) return false;
  if (typeof params.workflowName === "string" && run.workflowName !== params.workflowName) {
    return false;
  }
  if (typeof params.status === "string" && run.status !== params.status) return false;
  return true;
}

/**
 * `events.listByCorrelationId`, forwarded then filtered.
 *
 * A correlation id is chosen by the author (`createHook({ correlationId })`), so
 * two agents may legitimately use the same one and it cannot be required to belong
 * to this agent. The results are therefore filtered by the run each event belongs
 * to — and an event with no readable run id is DROPPED, because a value this code
 * cannot attribute is one it must not return.
 */
async function scopeFilterRuns(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const reply = await memberOf(ctx.storage, call.method)(...call.args);
  const items = pageItems(reply);
  if (items === undefined) return reply;
  const kept: unknown[] = [];
  for (const item of items) {
    const runId = entityRunId(item);
    if (runId !== undefined && (await ownsRun(ctx.sql, runId, ctx.slug))) kept.push(item);
  }
  return { ...(isRecord(reply) ? reply : {}), data: kept };
}

/**
 * `hooks.get` and `hooks.getByToken`, resolved then checked.
 *
 * A hook id and a token identify a hook, not a run, so the hook is fetched first
 * and the run it belongs to is what gets checked. A hook whose run this agent does
 * not own is a 404 — the same answer as a hook that does not exist, so a token is
 * not a way to confirm one.
 */
async function scopeResolveHook(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const hook = await memberOf(ctx.storage, call.method)(...call.args);
  const runId = entityRunId(hook);
  if (runId === undefined || !(await ownsRun(ctx.sql, runId, ctx.slug))) {
    throw new HTTPException(404, { message: "no such hook" });
  }
  return hook;
}

/**
 * `events.create`, the one mutation.
 *
 * Ownership is ESTABLISHED rather than verified, and the order is what makes it
 * safe:
 *
 * - A `run_created` with no run id has the DevKit generate one, so there is
 *   nothing to check beforehand — the run is claimed from the reply.
 * - A `run_created` with a CLIENT-supplied id is claimed FIRST, before the event is
 *   written. That ordering matters: claiming afterwards would leave a window in
 *   which the run exists and is unowned, and a crash inside it would leave a run
 *   nobody can read and nothing will clean up. `claimRun` refuses an id another
 *   agent already owns, so a guest cannot adopt someone else's run by asserting it.
 * - Every other event is on an EXISTING run, so it is checked like a read.
 */
async function scopeCreate(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const suppliedRunId = typeof call.args[0] === "string" ? call.args[0] : undefined;
  const create = memberOf(ctx.storage, "events.create");

  if (suppliedRunId !== undefined) {
    const data = call.args[1];
    const isRunCreated = isRecord(data) && data.type === "run_created";
    if (isRunCreated) {
      // Claim BEFORE writing — see above.
      await claimRun(ctx.sql, suppliedRunId, ctx.slug);
      return create(...call.args);
    }
    if (!(await ownsRun(ctx.sql, suppliedRunId, ctx.slug))) {
      throw new HTTPException(404, { message: "no such run" });
    }
    return create(...call.args);
  }

  // No run id: the DevKit generates one, and the reply carries it.
  const reply = await create(...call.args);
  const created = isRecord(reply) ? (entityRunId(reply.run) ?? entityRunId(reply)) : undefined;
  if (created === undefined) {
    // A run was created and cannot be attributed. Refusing to answer is the only
    // safe move: returning it would hand back a run no ownership row covers, which
    // nothing could ever read again and nothing would reap.
    log.warn("events.create returned no run id", { slug: ctx.slug });
    throw new HTTPException(502, { message: "run storage returned no run id" });
  }
  await claimRun(ctx.sql, created, ctx.slug);
  return reply;
}
