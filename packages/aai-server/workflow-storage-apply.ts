// Copyright 2026 the AAI authors. MIT license.
/**
 * Applying a storage call's scope, and forwarding it.
 *
 * The third file in a deliberate three-way split, and the boundaries are worth
 * stating because two of the three have similar names:
 *
 * - `workflow-storage-scope.ts` is the DECISION — a total
 *   `Record<StorageMethod, StorageScope>` saying how each method is scoped, so a
 *   method added to the DevKit is a compile error rather than an unscoped call.
 * - THIS file is the ENFORCEMENT: one function per scope kind, plus the dispatch
 *   that routes a call to its own. Everything here runs with the caller already
 *   authenticated and the slug already resolved.
 * - `workflow-storage-handler.ts` is the HTTP surface — bearer, body codec, the
 *   pooled connection, and the status taxonomy.
 *
 * It came out of the handler when that file passed its length cap. The seam is
 * real rather than convenient: nothing here touches a `Request` or a `Response`,
 * and nothing in the handler knows what a scope is.
 *
 * **The rule every function here shares: 404, never 403.** A 403 says a run id
 * exists, which is the one bit a caller must not be able to probe for — run ids
 * are ULIDs, and their unguessability is only worth something if nothing confirms
 * a guess.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "./logger.ts";
import {
  claimNewRun,
  claimRun,
  ownsRun,
  RunClaimRefusedError,
  runIdsFor,
} from "./workflow-run-owner.ts";
import { decideScope, type StorageMethod } from "./workflow-storage-scope.ts";
import type { PlatformWorldStorage } from "./workflow-storage-world.ts";
import { qualifyStreamName, unqualifyStreamName } from "./workflow-stream-namespace.ts";

const log = createLogger("workflow.storage");

/** How many runs `runs.list` answers with when the caller names no page size. */
const DEFAULT_RUN_PAGE = 50;

/** The most it will answer with, whatever the caller asks for. */
const MAX_RUN_PAGE = 500;

/**
 * The most run ids `runs.list` will WALK to fill one filtered page.
 *
 * A filter is applied after each run's record is fetched (see
 * {@link scopeOwnRuns}), so a page that matches nothing near the top costs one
 * `runs.get` per id scanned. Unbounded, a `status` filter matching nothing on an
 * agent with a hundred thousand runs is a hundred thousand reads for an empty
 * answer. Four full pages is far past any diagnostic surface's reach and still a
 * bounded cost; hitting it answers `hasMore: true`, which is the truth.
 */
const MAX_RUN_SCAN = MAX_RUN_PAGE * 4;

/** A minimal view of the DevKit members this route calls. */
export type Callable = (...args: unknown[]) => Promise<unknown>;

/** `{ method, args }`, validated. */
export type StorageCall = { method: StorageMethod; args: unknown[] };

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

export type ServeContext = {
  slug: string;
  sql: (q: string, p?: unknown[]) => Promise<Record<string, unknown>[]>;
  storage: PlatformWorldStorage;
};

/** Apply the call's scope, then forward it. */
export async function serve(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const decision = decideScope(call.method, call.args);
  if (!decision.ok) throw new HTTPException(400, { message: decision.reason });

  // The one check every run-keyed method shares. 404, never 403 — see the module
  // doc: a 403 would confirm that a run id exists.
  if (decision.requiredRunId !== undefined) {
    if (!(await ownsRun(ctx.sql, decision.requiredRunId, ctx.slug))) {
      throw new HTTPException(404, { message: "no such run" });
    }
    // The two STREAM kinds also carry a required run id, and they have more to do
    // once it checks out — the name has to be qualified, and a list of names
    // unqualified. Everything else is a plain forward.
    if (decision.scope.kind !== "stream" && decision.scope.kind !== "own-streams") {
      return memberOf(ctx.storage, call.method)(...call.args);
    }
  }

  switch (decision.scope.kind) {
    case "own-runs":
      return scopeOwnRuns(call, ctx);
    case "filter-runs":
      return scopeFilterRuns(call, ctx);
    case "resolve-hook":
      return scopeResolveHook(call, ctx);
    case "stream":
      return scopeStream(call, ctx, decision.scope.nameIndex);
    case "own-streams":
      return scopeOwnStreams(call, ctx);
    default:
      // A refused claim is answered 404, the same as every other way this surface
      // says "not yours". Letting `RunClaimRefusedError` reach the shared handler
      // would answer 5xx, which both reads as "retry me" for a decision no retry
      // changes and tells the caller its guessed run id names something real —
      // the distinction the never-403 rule above exists to deny.
      try {
        return await scopeCreate(call, ctx);
      } catch (err) {
        if (err instanceof RunClaimRefusedError) {
          // `cause` keeps WHICH refusal it was (foreign owner vs orphan) in the
          // log, while the wire body stays the one undifferentiated answer.
          throw new HTTPException(404, { message: "no such run", cause: err });
        }
        throw err;
      }
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
 *
 * **The filters are applied to a SCAN, not to one truncated page.** It used to
 * take the newest `limit` ids, filter those, and answer `hasMore: false` — so an
 * agent whose 50 newest runs are all `running`, asked for `status: "completed"`,
 * got an empty list plus an assurance that there was nothing further to fetch,
 * while completed runs sat one page back. The ownership table carries neither
 * field, so the filter cannot be pushed into the query; walking is what is left.
 * {@link MAX_RUN_SCAN} bounds it.
 */
async function scopeOwnRuns(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const params = isRecord(call.args[0]) ? call.args[0] : {};
  const pagination = isRecord(params.pagination) ? params.pagination : {};
  const asked = typeof pagination.limit === "number" ? pagination.limit : DEFAULT_RUN_PAGE;
  const limit = Math.max(1, Math.min(MAX_RUN_PAGE, asked));
  // One MORE than the page, so a full page can tell "there is another one" from
  // "that was all" without a second query — and so an unfiltered list still costs
  // exactly one batch, as it did before.
  const batch = limit + 1;

  const get = memberOf(ctx.storage, "runs.get");
  const wanted: unknown[] = [];
  let scanned = 0;
  let exhausted = false;
  while (wanted.length <= limit && scanned < MAX_RUN_SCAN) {
    const ids = await runIdsFor(ctx.sql, ctx.slug, batch, scanned);
    scanned += ids.length;
    const runs = await Promise.all(
      ids.map((id) =>
        // A run whose ownership row outlived its journal answers undefined rather
        // than failing the whole list — one missing run must not blank the pane.
        get(id, params).catch(() => undefined),
      ),
    );
    for (const run of runs) {
      if (run !== undefined && matches(run, params)) wanted.push(run);
    }
    // A short batch is the end of this agent's runs; anything else means the walk
    // stopped early and the caller may have more waiting.
    if (ids.length < batch) {
      exhausted = true;
      break;
    }
  }
  // Their own reply shape, so the guest's client needs no special case: a
  // paginated response with the items and no cursor.
  return {
    data: wanted.slice(0, limit),
    pagination: { hasMore: wanted.length > limit || !exhausted },
  };
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
 * The one method whose key is not a run id and cannot be made into one, so it is
 * the one method forwarded UNSCOPED and filtered on the way back. A correlation id
 * is the DevKit's own generated ULID — `step_<ulid>`, `hook_<ulid>`, `wait_<ulid>`
 * (`@workflow/core`'s `step.js`, `workflow/hook.js`, `sleep.js`) — and NOT an
 * author-chosen string: `HookOptions` has no `correlationId` field, only `token`.
 * (This comment used to say `createHook({ correlationId })`, describing an API
 * that does not exist. The scope choice is still right — the namespace is shared
 * across tenants and this code cannot require an id to be ours — but the reason
 * is unguessability of a generated id, not collision of business identifiers.)
 *
 * Each event is filtered by the run it belongs to, and an event with no readable
 * run id is DROPPED, because a value this code cannot attribute is one it must not
 * return.
 */
async function scopeFilterRuns(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const reply = await memberOf(ctx.storage, call.method)(...call.args);
  const items = pageItems(reply);
  if (items === undefined) {
    // FAIL CLOSED. A reply this code cannot read is a reply it cannot filter, and
    // returning it is returning an unfiltered cross-tenant page. `world-postgres`
    // always answers `{data, cursor, hasMore}` today, so this is unreachable on the
    // pinned version — which is exactly why it must not be a silent pass-through:
    // the whole point is the version where it stops being true.
    log.warn("listByCorrelationId reply is not a page", { slug: ctx.slug });
    throw new HTTPException(502, { message: "run storage returned an unreadable page" });
  }
  const kept: unknown[] = [];
  for (const item of items) {
    const runId = entityRunId(item);
    if (runId !== undefined && (await ownsRun(ctx.sql, runId, ctx.slug))) kept.push(item);
  }
  // Nothing was dropped, so the page is wholly this agent's and its own `cursor`
  // and `hasMore` describe it correctly.
  if (kept.length === items.length) return reply;
  // Something WAS dropped, so the DevKit's `cursor` and `hasMore` no longer
  // describe what is being returned — they are computed from the unfiltered page
  // (`storage.js`: `cursor: values.at(-1)?.eventId`, `hasMore: all.length > limit`),
  // so spreading them hands back another tenant's event id and an existence signal
  // for a correlation id that is not ours. The module rule one paragraph up says a
  // value this code cannot attribute must not be returned; a cursor derived from
  // foreign rows is such a value. Stop the page here instead.
  return { data: kept, cursor: null, hasMore: false };
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
 * A streamer call, with the stream NAME qualified per tenant.
 *
 * The run id has already been checked by the caller. What this adds is the
 * namespacing — see `workflow-stream-namespace.ts` for why it is a security fix
 * and not tidiness: their `readFromStream` looks a stream up by name alone, so two
 * agents sharing a name would share a stream.
 */
async function scopeStream(
  call: StorageCall,
  ctx: ServeContext,
  nameIndex: number,
): Promise<unknown> {
  const name = call.args[nameIndex];
  if (typeof name !== "string") {
    // `decideScope` has already required it; this is the narrowing.
    throw new HTTPException(400, { message: "stream name must be a string" });
  }
  const args = [...call.args];
  args[nameIndex] = qualifyStreamName(ctx.slug, name);
  return memberOf(ctx.storage, call.method)(...args);
}

/**
 * `listStreamsByRunId`, with the namespace taken back off.
 *
 * A name that does not carry this agent's prefix is DROPPED rather than passed
 * through. It should be unreachable — the run was already checked, and every
 * stream of that run was written through the qualifier — so a name from elsewhere
 * means an invariant broke, and handing back a value this code cannot attribute is
 * the wrong way to find that out.
 */
async function scopeOwnStreams(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const reply = await memberOf(ctx.storage, call.method)(...call.args);
  if (!Array.isArray(reply)) return reply;
  return reply.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const name = unqualifyStreamName(ctx.slug, entry);
    return name === undefined ? [] : [name];
  });
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
 *   nobody can read and nothing will clean up. `claimNewRun` refuses an id another
 *   agent owns AND one that already exists, so a guest cannot adopt someone else's
 *   run by asserting it.
 * - Every other event is on an EXISTING run, so it is checked like a read.
 *
 * **The discriminator is `eventType`, and reading the wrong field here is a
 * tenant-scoping bypass rather than a typo.** This branch is the whole
 * authorization decision for the one mutating method on this surface —
 * `decideScope` exempts `events.create` from the shared `ownsRun` gate and
 * delegates to this function — so whichever field it reads is a field the CALLER
 * controls. It read `data.type`, which the DevKit never sets: `CreateEventSchema`
 * (`@workflow/world`) is a discriminated union on `eventType` and declares no
 * `type` member at all, and the schema is `$strip`, so an undeclared `type` key
 * was accepted, dropped, and in the meantime skipped `ownsRun` entirely. That is
 * both halves of one bug — a guest could route any run id into the claim path by
 * adding one field, and a GENUINE `run_created` (which carries `eventType` and a
 * client-generated `wrun_<ULID>`, see `@workflow/core`'s `start.js`) fell through
 * to `ownsRun` on a run that does not exist yet and got 404, so durable run
 * creation did not work at all.
 */
async function scopeCreate(call: StorageCall, ctx: ServeContext): Promise<unknown> {
  const suppliedRunId = typeof call.args[0] === "string" ? call.args[0] : undefined;
  const create = memberOf(ctx.storage, "events.create");

  if (suppliedRunId !== undefined) {
    const data = call.args[1];
    const isRunCreated = isRecord(data) && data.eventType === "run_created";
    if (isRunCreated) {
      // Claim BEFORE writing — see above.
      await claimNewRun(ctx.sql, suppliedRunId, ctx.slug);
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
