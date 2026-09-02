// Copyright 2026 the AAI authors. MIT license.
/**
 * Turning a thrown value into a status a CALLER can act on.
 *
 * Split out of `workflow-api-http.ts`, which is otherwise about moving bytes —
 * bodies, SSE frames, bearer checks. This half is about a different question, and
 * one the repo has now got wrong in production three times: a caller has to be
 * able to tell "my request was wrong" from "come back shortly" from "the agent is
 * broken", and only the last is worth paging anyone about.
 *
 * **The rule this file exists to hold is that there is no THIRD state.** Every
 * environmental condition reachable here is either mapped to a status or named,
 * with a reason, as one a 500 is right for. "Nobody thought about this code" is
 * what both of the window's 500-that-should-have-been-503 defects were, and
 * `workflow-api-error-classification.test.ts` is what makes silence fail: it
 * sweeps the codes a Node service on this platform can actually meet and requires
 * an answer for each. Three of the entries below — `ENETDOWN`, `ENOTCONN`,
 * `EAGAIN` — and the whole {@link isResourceExhausted} branch came from that
 * sweep rather than from an incident, which is the point of running it.
 */

import { isRecord } from "@alexkroman1/aai/utils";
import { BodyTooLargeError, isCallerGone } from "./workflow-api-http.ts";

/**
 * Postgres SQLSTATE class 53 — "insufficient resources". A retryable CAPACITY
 * condition, never a bad request and never a broken agent.
 *
 * The class rather than a code list, and that is the point: every 53xxx is the
 * database saying it has run out of something (`53300 too_many_connections`,
 * `53200 out_of_memory`, `53100 disk_full`, `53400
 * configuration_limit_exceeded`). A caller's correct response to all four is
 * identical — wait and retry — and enumerating them invites the next one to be
 * missed.
 */
const RESOURCE_CLASS = "53";

/**
 * Is `err` the app database refusing work for want of capacity?
 *
 * Walks the `cause` chain, because the driver's error arrives wrapped: a
 * `too many connections for role` reaches the workflow API through
 * graphile-worker, drizzle and the DevKit's world, none of which re-throw the
 * original. Same traversal as `isPlatformDbUnreachable` on the platform side,
 * against a different condition — that one is "the database is unreachable",
 * this one is "the database answered, and the answer was no room".
 */
export function isInsufficientResources(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    const code = cur.code;
    // The length guard is what stops another vocabulary's `53…` passing as a
    // SQLSTATE: those are exactly five characters.
    if (typeof code === "string" && code.length === 5 && code.startsWith(RESOURCE_CLASS)) {
      return true;
    }
    cur = cur.cause;
  }
  return false;
}

/**
 * Is `err` the guest's own FILESYSTEM being full?
 *
 * `ENOSPC`, and it is not the database's `53` class: the local workflow world
 * keeps run state in a directory and the local upload store keeps an upload's
 * bytes beside it, so a guest with no `DATABASE_URL` writes both to a disk that
 * is a few gigabytes and has no cleanup.
 *
 * ## Why this needs naming rather than falling through to a 500
 *
 * Observed on a dev sandbox transcribing uploaded audio: every write raised
 * `ENOSPC`, the DevKit's local queue retried each message
 * (`Queue message failed (attempt 2, HTTP 500)`), the platform's forward saw the
 * connection reset and answered `503 agent unavailable, retry shortly` — and the
 * log filled with fifty identical lines naming a symptom nobody could act on.
 * Every layer read a full disk as transient. None of them is: retrying a write
 * that failed for want of space fails again, and the run only makes progress if
 * something outside the process frees bytes.
 *
 * So the status is **507 Insufficient Storage** with no `Retry-After`. 507 is
 * the one status that means exactly this, and omitting `Retry-After` is the
 * signal — the 503 beside it carries `"1"` because that condition clears on its
 * own, and this one does not.
 *
 * Same `cause` walk as {@link isInsufficientResources}, and for the same reason:
 * the error arrives wrapped by the DevKit's world, so the `code` is rarely on
 * the value that was thrown.
 */
export function isDiskFull(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    // `ENOSPC` exactly, never a prefix: `errno`/`code` are a closed vocabulary
    // and a `startsWith` would also match a hypothetical `ENOSPCFOO`.
    if (cur.code === "ENOSPC") return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Codes that mean this agent could not REACH something, rather than being asked
 * something it cannot do.
 *
 * A closed vocabulary, matched exactly, for the reason {@link isDiskFull} matches
 * `ENOSPC` exactly. `ENOTFOUND` is deliberately ABSENT: a hostname that does not
 * resolve is a misconfiguration, and answering "retry shortly" to it would hide a
 * permanent fault behind a client's retry loop forever. `EAI_AGAIN` — the
 * temporary DNS failure — is here for the mirror-image reason.
 */
const TRANSPORT_FAILURE_CODES: ReadonlySet<string> = new Set([
  // libuv, i.e. the socket
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "EAI_AGAIN",
  // Found by `workflow-api-error-classification.test.ts`, which requires every
  // reachable environmental code to have an ANSWER rather than requiring somebody
  // to have thought of it. All three are the same "a hop out failed" condition as
  // their neighbours and were absent only because no production incident had
  // named them yet: the interface went down, the socket was not connected, and
  // the operation would have blocked.
  "ENETDOWN",
  "ENOTCONN",
  "EAGAIN",
  // undici
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  // an HTTP/2 stream or connection error, which is what `_egress-fetch.ts` exists
  // to stop this runtime meeting — kept because the guest's own egress is not the
  // only hop between here and a bucket.
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
]);

/**
 * Local resources this PROCESS ran out of — descriptors, buffers, memory.
 *
 * A fourth condition the classification table had no entry for, found by the
 * class sweep rather than by an incident. It is neither of its neighbours: the
 * database has room and the network is fine, this process has hit a limit of its
 * own, so "could not reach the platform" would send an operator to the wrong
 * place and "the database is at capacity" to a different wrong place.
 *
 * 503 rather than 500 for the reason every other entry here is: the condition is
 * transient — a descriptor is returned, a buffer drains — so a client should back
 * off rather than treat the agent as broken, and `Retry-After` is what stops a
 * fan-out coming back together into a limit it is itself causing.
 *
 * `ENOMEM` is in the list and is the arguable one: a process that is simply
 * undersized will answer 503 forever rather than 500 forever, and neither is a
 * fix. It is here because the commoner cause by far is a transient spike under
 * concurrent uploads, where backing off genuinely clears it.
 */
const RESOURCE_EXHAUSTION_CODES: ReadonlySet<string> = new Set([
  "EMFILE",
  "ENFILE",
  "ENOBUFS",
  "ENOMEM",
]);

/** Has this process run out of a local resource? Same `cause` walk as its peers. */
export function isResourceExhausted(err: unknown): boolean {
  return hasErrorCode(err, RESOURCE_EXHAUSTION_CODES);
}

/**
 * The code `platform-rpc.ts` puts on a platform reply this guest should COME
 * BACK for — a {@link RETRYABLE_STATUS} from one of the four platform routes.
 *
 * Declared here rather than beside the throw because it is a classification,
 * and this file is the classification table; `platform-rpc.ts` imports it, the
 * same direction `BodyTooLargeError` already travels.
 *
 * ## The condition it names had no code, and so no status
 *
 * A platform route answering 503 — a shortage on the ADMIN pool, a partitioned
 * platform database, a replica shedding load — reached this table as
 * `new Error("journal appendStep answered HTTP 503: …")`, a plain `Error` whose
 * only distinguishing feature was a sentence. Every recognizer below reads a
 * `code`, so all of them declined it and the guest answered the browser **500
 * Internal server error**. That is wrong on the three counts this whole file is
 * about, and one more that is specific to it: the platform had ALREADY decided
 * the condition was transient and said so in a status, and the guest threw that
 * decision away between one hop and the next. A 500 tells the page never to
 * retry a condition whose entire nature is that it clears.
 *
 * A permanent answer keeps its 500 by construction: only a retryable status
 * gets this code, so a 400 (a call this guest built wrongly), a 401 (a bearer it
 * no longer holds), a 404 (a run it does not own) and a 501 (a deployment
 * without the feature) are unchanged — retrying any of those is what the
 * upload path's `RETRYABLE_STATUS` already exists to prevent, and reusing that
 * set is what keeps the two ends from drifting into two policies.
 */
export const PLATFORM_UNAVAILABLE_CODE = "PLATFORM_UNAVAILABLE";

const PLATFORM_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([PLATFORM_UNAVAILABLE_CODE]);

/**
 * Did a platform route tell this guest to come back? Same `cause` walk as its
 * peers — the throw is often wrapped by the client that made the call.
 */
export function isPlatformUnavailable(err: unknown): boolean {
  return hasErrorCode(err, PLATFORM_UNAVAILABLE_CODES);
}

/**
 * Did this request fail because a hop OUT of this agent failed?
 *
 * **The failure this exists for reached a client as `500 Internal server
 * error`.** A deployed guest's every byte operation and every platform call is a
 * request out of a sandbox (`_upload-blobs-brokered.ts`, `platform-rpc.ts`), and
 * `fetch` rejecting with `TypeError: fetch failed` — no status, the real code two
 * `cause` hops down — arrived at the router as an unnamed rejection. Observed in
 * production on a part claim: six consecutive
 * `PUT …/workflows/uploads/<id>/parts -> 500`, each ~40 s, each one making the
 * browser re-send 8 MB windows it had already stored, into the same fault.
 *
 * A 500 is the wrong answer to that on all three counts the table above is about.
 * It says the agent is broken when the agent is fine; it tells an operator
 * nothing, which is the whole finding of the `isInsufficientResources` entry; and
 * it carries no `Retry-After`, so a whole fan-out comes back at once. Same
 * `cause` walk as its two neighbours, and for the same reason — the code is
 * almost never on the value that was thrown.
 *
 * NOT the caller hanging up: {@link isCallerGone} reads that off the TOP-level
 * value and is checked first, where this reads a wrapped cause.
 */
export function isTransportFailure(err: unknown): boolean {
  return hasErrorCode(err, TRANSPORT_FAILURE_CODES);
}

/**
 * Does `err`, or anything in its `cause` chain, carry one of `codes`?
 *
 * The walk all three recognizers here need, spelled once. The `seen` set is not
 * defensive: a retry wrapper that re-throws its own cause makes a CYCLE, and
 * without it this loops forever inside an error handler — the one place a hang is
 * hardest to attribute.
 *
 * A wrapped cause rather than the thrown value is the normal case, not the edge
 * one: `fetch` rejects with a bare `TypeError: fetch failed` and the real code is
 * one or two hops down.
 */
function hasErrorCode(err: unknown, codes: ReadonlySet<string>): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    if (typeof cur.code === "string" && codes.has(cur.code)) return true;
    cur = cur.cause;
  }
  return false;
}

/**
 * Map a thrown value to a workflow-API status, or `false` to let it be a 500.
 *
 * Here rather than inline in `createWorkflowApi`'s `onError` because it is a
 * TABLE — four entries now — and because they are about one distinction: a
 * caller has to tell "my request was wrong", "come back shortly", "come back
 * when someone has freed space" and "the agent is broken" apart, and only the
 * last is worth paging anyone about.
 *
 * ORDER matters between the two 5xx entries. A full disk is checked FIRST
 * because it is the more specific condition and the only one that must not be
 * retried; the database-capacity 503 below it says "retry shortly" and would be
 * wrong advice for a disk.
 */
export function workflowApiErrorStatus(
  err: unknown,
): { status: number; error: string; retryAfter?: string } | false {
  if (err instanceof BodyTooLargeError) {
    // 413, not 400 or 500: the request was well-formed and too big.
    return { status: 413, error: err.message };
  }
  if (isDiskFull(err)) {
    // 507, and NO `Retry-After` — see `isDiskFull`. Every layer above this used
    // to read a full disk as transient and retry it, which is how one sandbox
    // produced fifty identical log lines and no progress.
    return {
      status: 507,
      error:
        "the agent's sandbox has no disk space left. This agent keeps workflow " +
        "runs and uploads on local disk because it has no DATABASE_URL; restart " +
        "it for a fresh sandbox, or set a DATABASE_URL secret so they are not " +
        "stored there at all.",
    };
  }
  if (isInsufficientResources(err)) {
    // 503, not 500: the request was fine and the DATABASE has no room.
    //
    // Measured — eight workflow guests booted at once against a 100-connection
    // instance saturated it, and every `POST /runs` that could not get a
    // connection answered `Internal server error`. A client cannot back off on
    // that, an operator cannot triage it, and a load balancer cannot shed on it.
    // With a 503 the same load reported capacity on four of eight agents and all
    // four succeeded within 60s of backing off.
    //
    // `Retry-After` is short on purpose: the condition clears as soon as one
    // guest's pool returns an idle connection (`POOL_IDLE_TIMEOUT_SECONDS`), not
    // on a human timescale.
    return {
      status: 503,
      error: "the agent's database is at capacity, retry shortly",
      retryAfter: "1",
    };
  }
  if (isResourceExhausted(err)) {
    // 503, and BEFORE the transport entry: a descriptor or buffer limit surfaces
    // on a socket operation, so it looks transport-shaped on the way out — and
    // "could not reach the platform" would send an operator to the network when
    // the limit is this process's own. Same ordering argument as the two 5xx
    // entries above it, which is now a three-way one.
    return {
      status: 503,
      error: "the agent is out of local resources, retry shortly",
      retryAfter: "1",
    };
  }
  if (isPlatformUnavailable(err)) {
    // 503, and BEFORE the transport entry for the reason the resource entry is:
    // this is the most specific of the three "a dependency said no" conditions,
    // and it is the only one whose advice came from the DEPENDENCY rather than
    // being inferred here. A platform 503 read as a transport failure would be
    // the right status by luck and the wrong sentence for an operator, who
    // should be looking at the platform replica rather than at the network
    // between it and this sandbox.
    return {
      status: 503,
      error: "the platform is at capacity, retry shortly",
      retryAfter: "1",
    };
  }
  if (!isCallerGone(err) && isTransportFailure(err)) {
    // 503, not 500: a hop out of this agent failed, and the request itself was
    // fine. See `isTransportFailure` for the production 500s this replaces.
    //
    // Checked LAST of the 5xx entries: a full disk and an exhausted connection
    // pool both surface transport-shaped codes on their way out, and each of those
    // has advice this one cannot give.
    //
    // And it DECLINES a caller that hung up, which is not politeness: `claimUnder`
    // runs this before its own `isCallerGone` branch, so without the guard an
    // inbound `ECONNRESET` would be answered 503 — into the socket that closed —
    // and the debug line that keeps 30 navigations-away out of the error log would
    // never run. `isCallerGone` reads the TOP-level value where this walks a
    // wrapped cause; the guard is what keeps that distinction true at the seam.
    //
    // `Retry-After` is short for the reason the capacity entry's is — a reset
    // clears on the next connection, not on a human timescale — and it is the half
    // a 500 could not carry, so a claim's concurrent probes back off together
    // instead of re-issuing into the same fault.
    return {
      status: 503,
      error: "the agent could not reach the platform, retry shortly",
      retryAfter: "1",
    };
  }
  return false;
}
