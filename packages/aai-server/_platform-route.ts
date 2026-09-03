// Copyright 2026 the AAI authors. MIT license.
/**
 * What the four guest-called platform routes do AROUND their own work.
 *
 * `_body-fields.ts` took the field readers off those handlers. What was left
 * duplicated is the frame every one of them is written inside, and it is the same
 * four decisions each time: the slug comes off the path and the sandbox bearer is
 * what proves it, a deployment that cannot serve the route at all answers 501
 * rather than 503, the work runs on a RESERVED admin connection that is released
 * whatever happens, and everything the work throws that is not already an answer
 * becomes a 503 with one warn line naming the slug.
 *
 * ## Validation runs OUTSIDE the reservation, and that is {@link PlatformCall}
 *
 * A malformed body is refused by `requiredString` and its siblings, which throw a
 * 400 — and for as long as those reads sat inside the `run` callback, they threw
 * with one of `ADMIN_POOL_MAX` connections reserved and idle. So a caller sending
 * bodies nothing could execute took the whole admin pool out of service for the
 * duration of four `HTTPException` constructions, and a legitimate enqueue queued
 * behind them. It is invisible to the specs that already assert "before any
 * statement": those read a statement RECORDER, which stays empty either way — the
 * cost was the door, not the query (`session-state-handler.test.ts` has the spy
 * that can see it).
 *
 * The shape is one per route: a `plan(method, ctx, body)` that reads every
 * caller-supplied field and returns the work as a {@link PlatformCall}, called
 * before {@link withReserved} and never inside it. Nothing about the four routes'
 * validation needs a connection — every check is a pure function over the parsed
 * body — so the split costs nothing and the ordering is then structural rather
 * than remembered.
 *
 * ## It had already drifted, and in the direction that costs a run
 *
 * Three of the four routes rethrow an `HTTPException` before reaching
 * their 503; `workflow-enqueue-handler.ts` did not. An `HTTPException` raised
 * inside the work is a DECISION the route already made — a 400 naming a field, a
 * 501 for a method the world does not expose — and flattening one into a 503 tells
 * the guest to retry a request that can never succeed, which for the queue means
 * the delivery sweep re-running a permanently-failing step with backoff. The
 * storage route has a spec for exactly that case ("a method their world does not
 * expose answers 501, not 500"); the enqueue route had the same code path and no
 * guard.
 *
 * ## {@link guestSlug} and {@link withReserved} are two functions, not one wrapper
 *
 * The shared part of a route is its DOOR; how it reaches a database is a separate
 * question. There used to be a fifth route making that concrete — the DevKit's
 * run-stream read (`workflow-stream-handler.ts`, deleted with the DevKit), which
 * took the preamble and NOT the reservation, because a live read holds its
 * response open for up to ten minutes and must not hold a pooled connection for
 * that long. It is worth keeping the seam: the next route with a response longer
 * than a query takes the door and reaches its data some other way.
 *
 * ## Why not zod, which this package already uses
 *
 * Same answer as `_body-fields.ts`, and for the same reason: these routes dispatch
 * on a `method` field whose required fields differ per method, so one schema per
 * route has to be a discriminated union over the method. That is worth doing and
 * worth doing on its own.
 *
 * @internal
 */

import { errorMessage } from "@alexkroman1/aai";
import type { Logger } from "@alexkroman1/aai-runtime";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import { assertGuestBearer } from "./guest-bearer.ts";
import { PLATFORM_DB_RESERVE_TIMEOUT_MS } from "./platform-db-errors.ts";
import type { AdminDb } from "./platform-lock.ts";
import type { SqlExec } from "./secret-store.ts";

/**
 * The slug this request is for, once this sandbox's bearer has proved it.
 *
 * Every platform route begins here, and the ORDER is the tenant boundary: a slug
 * read off the path means nothing until the bearer presented with it is checked
 * against that slug, and everything downstream takes the slug from this return
 * value rather than from the request again.
 *
 * @internal
 */
export async function guestSlug(c: AppContext): Promise<string> {
  const slug = c.var.slug;
  await assertGuestBearer(c, slug);
  return slug;
}

/**
 * The 501 a route answers when this deployment cannot serve it at all.
 *
 * 501 and not 503, which is the distinction the whole guest-side retry policy
 * rests on: 503 says "later", and there is no later here — no platform database
 * means no queue, no run storage, no session state and no upload records, on this
 * deployment, permanently.
 *
 * ## A 501 is TERMINAL for the caller. Nothing falls back
 *
 * Two of these handlers used to say the guest "falls back to memory / to its
 * local store, SAYING so", and no such code was ever written on either side.
 * Both guest-side backends are selected ONCE, at construction, from whether the
 * boot env named a platform (`resolvePlatformQueue`) — `selectBackend` in
 * `aai-runtime/runtime-session-state.ts` and the `opts.platform` arm of
 * `createUploadStore` — so a status arriving per request cannot reach the
 * decision, and `uploads-platform.ts` states the consequence correctly for its
 * side: "the store above has no fallback". A 501 fails the call, and for session
 * state that is `hydrate`, i.e. the session START.
 *
 * That is the right behaviour to describe rather than the wrong one to
 * implement: a backend that silently downgraded would take an agent the boot log
 * called `durable: true` and make it memory, which is the failure that guide
 * calls worse than admitting memory up front. What it leaves open is one
 * REACHABLE configuration — a memory-tier platform (no `SUPABASE_DB_URL`) in
 * local dev, where `agentPlatformBaseUrl` derives an origin from this server's own
 * port and so ALWAYS puts `AAI_PLATFORM_BASE_URL` in a guest's boot env (it used
 * to need `rememberPublicOrigin` to have observed one, which made this
 * order-dependent rather than absent) — where every deployed agent picks
 * these backends and every session start then fails on a 501. The fix is a
 * deployment refusing to spawn a guest it cannot serve, or a boot env that omits
 * the platform keys on that tier; it is not a fallback, and it is not this
 * function's to make.
 *
 * @internal
 */
export function notConfigured(what: string): HTTPException {
  return new HTTPException(501, { message: `${what} not configured` });
}

/**
 * One route's work, with every caller-supplied field ALREADY READ.
 *
 * A route's `plan(method, ctx, body)` returns one of these: the reads that can
 * throw a 400 have happened, and what is left needs nothing but a connection. That
 * is what lets {@link withReserved} be the LAST thing a handler does — see the
 * module doc for what it cost when it was the first.
 *
 * @internal
 */
export type PlatformCall<T = unknown> = (sql: SqlExec) => Promise<T>;

/** How one route reports work that failed for a reason it has no answer for. */
export type ReservedCall = {
  /** This route's own logger — the namespace is what makes a warn line findable. */
  log: Logger;
  /** The 503's message. A tenant reads this one. */
  failure: string;
  /** What the warn line says, when that is not the 503's own message. */
  logMessage?: string | undefined;
  /** What the warn line carries besides the error: the slug, and the method where a route has one. */
  detail: Record<string, unknown>;
  /**
   * A domain error this route answers with a status of its own.
   *
   * Consulted after `HTTPException` and before the 503. Only the upload records
   * route has one: a refused claim is that route WORKING, so it answers 409 and is
   * not logged as a failure.
   */
  statusFor?: ((err: unknown) => HTTPException | undefined) | undefined;
};

/**
 * How long a route may wait for an admin connection before the WAIT is the news.
 *
 * A tenth of {@link PLATFORM_DB_RESERVE_TIMEOUT_MS}, derived rather than written
 * down twice: the two describe the same pressure at different heights, and a
 * threshold that did not move with the deadline would eventually sit above it
 * and never fire at all.
 *
 * Nothing legitimate waits this long. That constant's own doc is the argument —
 * every reservation on this pool is one guest request or one queue statement, so
 * half a second of queueing is a pool with nothing to give rather than a pool
 * that is busy — which is what makes a line here a fact about the POOL and not
 * about whichever route happened to print it.
 *
 * @internal
 */
export const RESERVE_WAIT_WARN_MS = PLATFORM_DB_RESERVE_TIMEOUT_MS / 10;

/**
 * Run one call on a reserved admin connection, and release it whatever happens.
 *
 * ## The ACQUIRE is timed, because the number was unobservable and load-bearing
 *
 * A guest-called platform route is one `POST` holding one of `ADMIN_POOL_MAX`
 * connections for its whole duration, and the measured cost of the busiest of
 * them — the journal RPC, at ~840 ms of server time
 * (`packages/aai-runtime/CLAUDE.md`, "A journal read is a round trip") — was a
 * total with no breakdown. So the one question an operator actually has about it
 * had no answer from inside the system: is that our own pool queueing, or is it
 * the proxy and the round trip? Those have opposite remedies — the first is a
 * pool or a call-volume problem, the second cannot be fixed by widening
 * anything — and `ADMIN_POOL_MAX` had already been widened once on the
 * assumption.
 *
 * Three lines, and which one a request prints is the answer:
 *
 * - **A wait past {@link RESERVE_WAIT_WARN_MS} WARNS.** Unambiguously abnormal,
 *   per that constant's doc, and it names the pool rather than the route.
 * - **Every other reservation logs at DEBUG**, which `consoleLogger` makes a
 *   no-op unless `AAI_DEBUG=1` — so the distribution is readable on one replica
 *   on demand, and absence of a warn is not the only evidence available. That
 *   matters: "no warns" is indistinguishable from "not deployed" otherwise.
 * - **A FAILED acquire warns with the wait it spent.** It used to log nothing
 *   at all here, because the reservation is taken before the `try` below — so
 *   `POOL_EXHAUSTED` at the 5s deadline reached the router's error handler with
 *   no line naming the slug, and the 503 read as the route's fault. The error is
 *   rethrown UNCHANGED: `isPlatformDbUnreachable` is what classifies it and this
 *   only reports it.
 *
 * The 503 below carries `waitedMs` and `workMs` for the same reason — a failure
 * after 20 ms of work behind 4,900 ms of queueing is a different incident from
 * one that spent thirty seconds in a statement, and the old line could not tell
 * them apart.
 *
 * @internal
 */
export async function withReserved<T>(
  adminDb: AdminDb,
  call: ReservedCall,
  run: (sql: SqlExec) => Promise<T>,
): Promise<T> {
  const askedAt = performance.now();
  const since = (from: number) => Math.round(performance.now() - from);
  let reserved: Awaited<ReturnType<AdminDb["reserve"]>>;
  try {
    reserved = await adminDb.reserve();
  } catch (err: unknown) {
    call.log.warn("Platform admin reservation failed", {
      ...call.detail,
      waitedMs: since(askedAt),
      error: errorMessage(err),
    });
    throw err;
  }
  const waitedMs = since(askedAt);
  const line = { ...call.detail, waitedMs };
  if (waitedMs >= RESERVE_WAIT_WARN_MS) call.log.warn("Platform admin reservation was slow", line);
  else call.log.debug("Platform admin reservation", line);
  const heldAt = performance.now();
  try {
    return await run((q, p) => reserved.query(q, p));
  } catch (err: unknown) {
    // An answer the route already decided on. Re-wrapping one as a 503 tells the
    // guest to retry a request that can never succeed — see the module doc.
    if (err instanceof HTTPException) throw err;
    const own = call.statusFor?.(err);
    if (own) throw own;
    call.log.warn(call.logMessage ?? call.failure, {
      ...call.detail,
      waitedMs,
      workMs: since(heldAt),
      error: errorMessage(err),
    });
    // 503 rather than 500: from the guest's point of view every remaining cause is
    // transient — a connection shortage, a partitioned database — and the caller
    // above (the DevKit's step retry, the runtime's own flush) is built to retry.
    throw new HTTPException(503, { message: call.failure, cause: err });
  } finally {
    reserved.release();
  }
}
