// Copyright 2026 the AAI authors. MIT license.
/**
 * "The platform database is UNREACHABLE" as a type, so the HTTP surface can
 * say 503 instead of 500.
 *
 * The same gap `SandboxUnavailableError` closed for spawns, one dependency
 * over. A platform-Postgres connection failure reached `createErrorHandler` as
 * a bare `Error`, so it was logged `unhandled error on /studio/account` and
 * answered `500 Internal server error` — and both halves were wrong. The
 * platform is not broken, the studio client (which retries 5xx) left the user
 * staring at "Internal server error" once its retries ran out, and nothing in
 * the log said which dependency was down.
 *
 * It is not hypothetical: production spent 20+ minutes answering 500 on
 * `/studio/account` with `getaddrinfo ENOTFOUND db.<ref>.supabase.co` in the
 * detail, after a Modal secret pointed a pool at Supabase's DIRECT host — which
 * has no A record on a project without the IPv4 add-on, so every query failed
 * DNS (see `platform-connection-config.ts` for the guard that now refuses that
 * value).
 *
 * ## What counts, and what deliberately does not
 *
 * REACHABILITY only: DNS, connect, socket and "no capacity for another
 * connection". A constraint violation, a syntax error, a missing column — every
 * failure that means "this query is wrong" — stays a 500, because that IS a
 * server fault and a 503 would tell the caller to retry something that can
 * never succeed. The predicate therefore matches on error CODE rather than on
 * message text, and walks the `cause` chain: postgres.js wraps a socket failure
 * in its own error.
 *
 * ## Why a wrapper at the pool, not a `catch` per route
 *
 * There are ~40 platform reads behind the studio and agent surfaces (agents
 * rows, Vault, workspaces, chats, the wake sweep's reserved connection), and a
 * classification each is a classification each to forget. The two PLATFORM
 * pools are the seam every one of them crosses, so wrapping the pool makes the
 * taxonomy a property of the connection instead of a rule per call site.
 *
 * A database an AUTHOR brings — `DATABASE_URL` in their own secrets — is
 * deliberately NOT wrapped, and never was: it being down is a claim about one
 * tenant's agent rather than about the platform, and it is reached from inside the
 * guest, where none of this code runs.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import type { CloseableDb, ReservedDb } from "@alexkroman1/aai-runtime";

/**
 * Seconds the platform pools wait for a NEW connection before failing. Bounds
 * the partition-during-connect case: postgres.js raises `CONNECT_TIMEOUT`,
 * one of the {@link isPlatformDbUnreachable} codes below, so a caller sheds
 * load as a 503 instead of waiting out the driver's 30s default. Lives here,
 * beside the codes it maps to, because `constants.ts` is at its file-length cap.
 */
export const PLATFORM_DB_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * Client-side deadline for a query on the ADMIN pool — BOTH of its paths. The
 * POOLED one carries the stores and the rate limiters; the RESERVED one carries
 * every guest platform route (the workflow journal, the queue, session state,
 * upload records), each of which holds a reservation for the life of its request
 * (`_platform-route.ts`'s `withReserved`) and takes no advisory lock. So
 * `service-config.ts` passes this number as `queryTimeoutMs` AND as
 * `reservedQueryTimeoutMs` there — unbounded, `ADMIN_POOL_MAX` hung reads leave
 * every other platform read on the replica queued behind them. That was
 * reachable with FOUR concurrent watchers when the pool was 4; at 16 it takes
 * sixteen, which is a wider door and the same room behind it.
 *
 * It bounds a STATEMENT, never a HOLD, which is what keeps the queue sweep legal:
 * it reserves a connection across a delivery that can take minutes while every
 * individual statement on it is brief.
 *
 * The bound exists because a silent partition — an established connection that
 * stops answering: a failover, a lock storm, a frozen host — otherwise hangs the
 * request forever. Generous enough for the largest legitimate write (a ~30 MB
 * deploy blob upsert) and far under an unbounded hang; on the timeout the query
 * rejects with a `QUERY_TIMEOUT`-coded error (in
 * {@link isPlatformDbUnreachable}) → 503.
 *
 * **The one exempt path is the SLUG-LOCK pool's reservation**, which takes
 * neither bound. Its whole job is holding `pg_advisory_lock` across a deploy —
 * blob uploads, config extraction, a sandbox spawn — so a per-statement deadline
 * would abort deploys; the wait there that does need bounding, the ACQUIRE,
 * carries its own `lock_timeout` on the connection (`platform-lock.ts`). That
 * asymmetry is why the reserved deadline is per POOL rather than a blanket on
 * `reserve()`, and `service-config.test.ts` asserts both halves — a future "set
 * it everywhere" tidy-up would break deploys in production only.
 *
 * **A server `set statement_timeout` is NOT the mechanism, and cannot be.** It
 * is the obvious thing to reach for and it fails on the very case this exists
 * for, twice: the failure mode is a SILENT partition, so Postgres's own
 * cancellation notice is blackholed along with every other byte on that
 * connection — and `set statement_timeout` is itself a query on that connection,
 * so on a partition the guard cannot even be installed. A CLIENT-side deadline
 * is the only bound that survives, because it needs to hear nothing back.
 * Nothing in this repository sets a `statement_timeout` anywhere.
 */
export const PLATFORM_DB_QUERY_TIMEOUT_MS = 30_000;

/**
 * How long a guest platform route waits for one of the ADMIN pool's
 * connections before answering 503.
 *
 * The other half of the bound above, and the one that was missing.
 * `PLATFORM_DB_QUERY_TIMEOUT_MS` bounds a statement running ON a reservation;
 * this bounds the wait to GET one, which `reserve()` left unbounded — so at
 * exhaustion the first deadline to fire belonged to the CALLER, four layers up
 * and in another process. The guest's tightest is `SESSION_STATE_TIMEOUT_MS`
 * (10s) and its journal's is 15s, and what those produce is a timeout: no
 * status, no `Retry-After`, and a diagnosis that names the journal when nothing
 * was wrong with the journal. `withReserved` never even ran, because the
 * reservation is taken before its `try`.
 *
 * **5 seconds, chosen against the SHORTEST caller rather than the pool.** It
 * has to fire first for the answer to be a status at all, and it has to leave
 * the caller enough of its own budget to receive one — half of 10s does both.
 * Nothing legitimate waits that long here: every reservation on this pool is
 * one guest request or one queue statement (`workflow-queue-sweep.ts` reserves
 * per STATEMENT for exactly this reason), so five seconds of queueing is a pool
 * with nothing to give rather than a pool that is busy.
 *
 * **The SLUG-LOCK pool takes no such bound**, and the asymmetry is the same one
 * `PLATFORM_DB_QUERY_TIMEOUT_MS` makes one paragraph up, only sharper: a
 * reservation there is held for a whole deploy, so a fifth concurrent
 * distinct-slug mutation legitimately waits minutes for a connection and a
 * deadline would fail deploys under ordinary load. `service-config.test.ts`
 * asserts both halves, because a future "set it everywhere" tidy-up would be
 * invisible until production.
 */
export const PLATFORM_DB_RESERVE_TIMEOUT_MS = 5000;

/**
 * A platform-database operation that failed because the database could not be
 * REACHED — not because the statement was wrong.
 *
 * A marker class, not a message: the message stays the driver's own technical
 * one (`getaddrinfo ENOTFOUND db.…`, `Connection terminated unexpectedly`) and
 * the original is kept as `cause`, so the log keeps the diagnosis while the
 * wire body gets the authored sentence in `error-handler.ts`. Same split as
 * `SandboxUnavailableError`.
 */
export class PlatformDbUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlatformDbUnavailableError";
  }
}

/**
 * Error codes that mean "could not reach the database", from the three layers
 * that produce one.
 *
 * - **Node/libuv**, on DNS and TCP: `ENOTFOUND` is the misconfigured-host case
 *   this class was written for, `EAI_AGAIN` its transient sibling.
 * - **postgres.js**, whose own codes are strings on `err.code`: a connect that
 *   timed out, and the three ways it reports a pool connection that went away.
 * - **Postgres itself**, by SQLSTATE: `53300` too_many_connections and `57P03`
 *   cannot_connect_now (starting up / shutting down). Both are "there is no
 *   connection for you", which is a 503 and not a bug in the statement — and
 *   `53300` is exactly what the connection budget in `platform-db-capacity.ts`
 *   exists to keep away from.
 */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  // A pooled query that blew its client-side deadline (createPostgresDb's
  // `queryTimeoutMs`) — the only signal a SILENT partition produces, where the
  // established connection stops answering and no driver-level error ever
  // arrives. Treated as unreachable so the stall sheds load as a 503.
  "QUERY_TIMEOUT",
  // The pool had no connection to reserve within
  // `PLATFORM_DB_RESERVE_TIMEOUT_MS`. The same condition `53300` names one layer
  // down — "there is no connection for you" — reached before the driver opens
  // one rather than after Postgres refuses it, so it belongs to the same 503.
  // Without this the wait was unbounded and the condition had no code at all.
  "POOL_EXHAUSTED",
  "53300",
  "57P03",
]);

/**
 * The SQLSTATE `err` carries, or `undefined` when it carries none.
 *
 * Three predicates read this field with three different hand-written casts —
 * `(err as { code?: unknown }).code`, and twice the same with `| null` and `?.` —
 * so the repo paid three `as` escape hatches for a narrowing this module already
 * did correctly one function below, via `isRecord`. Deliberately NOT a cause-chain
 * walk like {@link isPlatformDbUnreachable}: each caller is deciding what its OWN
 * statement did (`55P03`, `23505`, `23503`), and a nested unique violation from
 * somewhere else in a chain is a different event, not a stronger signal.
 */
export function sqlState(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}

/**
 * Whether `err` (or anything in its `cause` chain) means the platform database
 * could not be reached.
 *
 * Cycle-guarded, for the same reason `causeChain` in `error-handler.ts` is: a
 * `cause` chain is not required to be one.
 */
export function isPlatformDbUnreachable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof PlatformDbUnavailableError) return true;
    const code = cur.code;
    if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Run `op`, re-throwing a reachability failure as
 * {@link PlatformDbUnavailableError} and everything else untouched.
 *
 * An error that is ALREADY one passes through rather than nesting: a reserved
 * connection's query goes through this twice (its own wrapper, then whatever
 * the caller wrapped), and a chain of identical wrappers would make
 * `causeChain` print the same sentence three times.
 */
export async function withPlatformDb<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof PlatformDbUnavailableError) throw err;
    if (!isPlatformDbUnreachable(err)) throw err;
    throw new PlatformDbUnavailableError(
      err instanceof Error ? err.message : String(err),
      // `cause` carries the driver's error with its own code and stack; the
      // handler walks to it.
      { cause: err },
    );
  }
}

/**
 * The same pool, with every query's reachability failure typed.
 *
 * Wraps `query` and — because a reserved connection is where the wake sweep and
 * the slug lock do their work — `reserve()` itself and the reserved handle's
 * `query`. `release` and `close` are pass-through: neither talks to the network
 * in a way a caller can act on, and a `close` that throws during shutdown must
 * not be dressed up as a request-time 503.
 */
export function platformDb(db: CloseableDb): CloseableDb {
  const wrapReserved = (reserved: ReservedDb): ReservedDb => ({
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> =>
      withPlatformDb(() => reserved.query<T>(sql, params)),
    release: () => reserved.release(),
  });
  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> =>
      withPlatformDb(() => db.query<T>(sql, params)),
    reserve: () => withPlatformDb(() => db.reserve().then(wrapReserved)),
    // NOT wrapped in `withPlatformDb`, and the asymmetry is the point: this
    // classifies a QUERY's failure into a taxonomy the request paths map to a
    // status, and a `LISTEN` has no request behind it. A subscription that cannot
    // be established is the listener's own problem — its caller falls back to
    // polling and says so — while translating it here would attach a 503 to a
    // caller who is not waiting for one.
    listen: (channel, onNotify) => db.listen(channel, onNotify),
    close: () => db.close(),
  };
}
