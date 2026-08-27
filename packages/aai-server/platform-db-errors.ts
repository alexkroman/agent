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
 * Per-APP databases are deliberately NOT wrapped: an app database being down is
 * a claim about one tenant's agent rather than about the platform, and the
 * routes that touch it own that answer.
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
 * Client-side deadline for a query on the ADMIN pool's POOLED path (the stores,
 * the rate limiters — every short read a request makes). A silent partition (an
 * established connection that stops answering — a failover, a lock storm, a
 * frozen host) otherwise hangs the request forever: a server `statement_timeout`
 * cannot help, because its own cancellation notice is blackholed with every
 * other byte. Generous enough for the largest legitimate write (a ~30 MB deploy
 * blob upsert) and far under an unbounded hang; on the timeout the query rejects
 * with a `QUERY_TIMEOUT`-coded error (in {@link isPlatformDbUnreachable}) → 503.
 * RESERVED connections (the workflow-wake sweep's advisory lock, which carries
 * its own `statement_timeout`) are exempt — only the pooled path is wrapped.
 */
export const PLATFORM_DB_QUERY_TIMEOUT_MS = 30_000;

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
  "53300",
  "57P03",
]);

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
    close: () => db.close(),
  };
}
