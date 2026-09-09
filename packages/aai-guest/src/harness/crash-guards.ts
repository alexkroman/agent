// Copyright 2026 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";

/**
 * Postgres SQLSTATEs that mean THE LINK WENT AWAY, and never that local state is
 * torn.
 *
 * Class 08 is connection exception; `57P01`/`57P02`/`57P03` are the server saying
 * it is shutting the session (or itself) down. In every one of them the client
 * library's own recovery is to discard the connection and open another — there is
 * no partially-applied local mutation to reason about, which is the entire premise
 * behind exiting on an uncaught exception.
 *
 * Enumerated rather than matched by prefix so that adding one is a decision. In
 * particular `57014` (`query_canceled`) is deliberately absent: a cancelled query
 * is a statement timeout, which says nothing about the connection.
 */
const CONNECTION_LOST_SQLSTATES = new Set([
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "57P01", // admin_shutdown — "terminating connection due to administrator command"
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/**
 * How far down `cause` to look. A pool wraps the backend's error when a checkout
 * fails, and the DevKit can wrap that again; past a couple of links the value is
 * no longer describing this failure.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * Whether an uncaught value is a Postgres connection that went away.
 *
 * Reads the driver's `code`, not the message: SQLSTATE is a wire-level contract
 * and the sentence beside it is localized and reworded between releases.
 *
 * ITERATIVE and depth-bounded, because a `cause` chain is attacker-shaped input in
 * the one place that must not fail: an `a.cause = b; b.cause = a` cycle recurses
 * until the stack blows, and it would blow INSIDE the `uncaughtException` handler,
 * which is the last thing left to report the crash. A guard cannot afford its own
 * crash. (A self-reference check alone does not cover this — the shortest cycle it
 * misses is two links long.)
 */
function isLostConnection(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!isRecord(current)) return false;
    const code = current.code;
    if (typeof code === "string" && CONNECTION_LOST_SQLSTATES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Keep one bad turn from killing the sandbox.
 *
 * A guest serves MANY things at once — the host control channel, every live
 * voice session, and (for studio projects) the coding-agent chat. Node's
 * default for an unhandled rejection is to exit the process, so a single
 * stray rejection anywhere takes all of them down together.
 *
 * That is not hypothetical: undici raises `UND_ERR_BODY_TIMEOUT` on a
 * stalled LLM response from a socket callback, outside any turn's promise
 * chain, and the whole sandbox died mid-session — observed while running the
 * studio starter evals.
 *
 * Rejections are logged and swallowed: the turn that owned it fails on its
 * own error path, and everything else keeps serving. An uncaught *exception*
 * is different — it can leave state torn — so that one is logged and then
 * rethrown by exiting, which the host notices as a dead guest and replaces.
 *
 * ## Except a database that went away, which is not torn state
 *
 * The one measured exception, and it is a whole class rather than a special case.
 * Deleting a studio project drops the app database's role, which TERMINATES its
 * backends (`57P01`) — and the platform cannot order those two events: the
 * teardown of the resident sandbox queues behind the same slug lock the delete
 * holds, and the replica that owns the sandbox is often not the replica running
 * the delete. So a guest WILL see its database vanish underneath it, by design,
 * and the same shape arrives from a Supabase restart or a failover, neither of
 * which is anybody's bug.
 *
 * What that did to a guest: graphile-worker's `pg` pool raised the terminated
 * connection as an EventEmitter `error` with no listener — an uncaught exception
 * from inside a dependency — so the guest logged `Guest: uncaught exception;
 * exiting` and died, taking every live VOICE SESSION on that sandbox with it.
 * Those sessions have nothing to do with the deleted project's database. The
 * platform log also took ~430 lines of `pg` client internals per occurrence
 * (`secretKey`, `saslSession`, pool counters), which is the dependency's own
 * logger dumping the error object.
 *
 * These are logged and swallowed, exactly like a rejection. The library reconnects
 * or it does not; if the database is really gone the guest idles out in five
 * minutes and its sandbox is terminated by the change event anyway — which is the
 * outcome the crash produced, minus the sessions it took with it. That leaves the
 * ONE case where exiting is still right (`process.exit`) for errors that could
 * actually have left state half-applied.
 */
export function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error(`Guest: unhandled rejection (session continues): ${errorMessage(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    if (isLostConnection(err)) {
      // Names the SQLSTATE, because "the database went away" has several causes
      // (a project delete, a restart, a failover) and the code is what tells them
      // apart in a log nobody is watching at the time.
      const code = isRecord(err) && typeof err.code === "string" ? err.code : "unknown";
      console.error(
        `Guest: database connection lost (${code}); sessions continue: ${errorMessage(err)}`,
      );
      return;
    }
    console.error(`Guest: uncaught exception; exiting: ${errorMessage(err)}`);
    process.exit(4);
  });
}
