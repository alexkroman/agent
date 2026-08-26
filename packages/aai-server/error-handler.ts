// Copyright 2025 the AAI authors. MIT license.

import { errorDetail, errorMessage } from "@alexkroman1/aai";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { isRecord } from "@alexkroman1/aai/utils";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createLogger } from "./logger.ts";
import { PlatformDbUnavailableError } from "./platform-db-errors.ts";
import { SlugLockTimeoutError } from "./platform-lock.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";

const log = createLogger("http");

/**
 * What a caller is told when a sandbox could not be started. Authored here
 * rather than taken from the error, whose message is the backend's technical
 * one — see sandbox-errors.ts for why the two are kept apart. It is written
 * for a studio user reading it in the chat panel: what happened, and that
 * trying again is the move.
 */
export const SANDBOX_UNAVAILABLE_MESSAGE =
  "Could not start a sandbox for this project — the platform is at capacity or the sandbox took too long to boot. This is usually temporary; try again.";

/**
 * What a caller is told when the platform's own database could not be reached.
 *
 * Same split as {@link SANDBOX_UNAVAILABLE_MESSAGE}: the driver's message
 * (`getaddrinfo ENOTFOUND db.<ref>.supabase.co`) names our infrastructure and
 * would leak a hostname to an unauthenticated caller, so it stays in the log
 * and this stays on the wire. It says "temporarily" because that is what a 503
 * promises, and because the alternative — a misconfigured connection string —
 * is not something the caller can distinguish or act on differently.
 */
export const PLATFORM_DB_UNAVAILABLE_MESSAGE =
  "The platform is temporarily unable to reach its database, so this request could not be served. Try again shortly.";

/**
 * An error and every `cause` under it, as one line.
 *
 * The chain is where the diagnosis lives on this surface: an `HTTPException`'s own
 * message is authored FOR THE CALLER (`AGENT_UNAVAILABLE_MESSAGE` is one sentence
 * about retrying) and its stack names the throw site, so neither says which of the
 * three conditions behind a 503 actually happened. `unavailable(cause)` in
 * `workflow-handler.ts` attaches the real one; without walking to it the log would
 * print the caller-facing sentence and call that a diagnosis.
 *
 * Cycle-guarded, because a `cause` chain is not required to be one.
 */
function causeChain(err: unknown): string {
  const parts: string[] = [errorDetail(err)];
  const seen = new Set<unknown>([err]);
  let cur: unknown = isRecord(err) ? err.cause : undefined;
  while (isRecord(cur) && !seen.has(cur)) {
    seen.add(cur);
    parts.push(errorMessage(cur));
    cur = cur.cause;
  }
  return parts.join(" <- ");
}

/**
 * Shared Hono error handler for the platform services. Unhandled errors are
 * logged with full detail but answered with an opaque 500 — raw messages
 * can leak internals to unauthenticated callers.
 */
export function createErrorHandler(): ErrorHandler {
  return (err, c) => {
    if (err instanceof HTTPException) {
      // A 5xx says the PLATFORM failed, so its cause is a diagnosis and not
      // chatter — and this branch was throwing every one away. The proxy routes
      // build theirs as `unavailable(cause)` with the real reason attached (an
      // aborted forward, a refused connection, a broker that gave up), all of
      // which reached a caller as one sentence and the log as nothing at all: 27
      // upload `PUT`s answered 503 inside one hour of production log with no
      // server-side line anywhere, so the deadline behind them had to be
      // reconstructed from Modal's request durations. A 4xx stays quiet, being a
      // statement about the CALLER's request and unbounded in volume.
      if (err.status >= 500) {
        log.warn(`${err.status} on ${c.req.path}`, { cause: causeChain(err) });
      }
      return c.json({ error: err.message }, err.status);
    }
    // A ZodError's own `message` is `JSON.stringify(issues, null, 2)`, so this
    // answered a one-field mistake with a multi-line array of `{ origin, code,
    // path }` objects — the shape `formatSchemaIssues` exists to replace (see
    // `sdk/utils.ts`). It reached the CLI, which then had to un-bury it again
    // (`describeErrorBody` in `aai-cli/_api-client.ts`), and reached the studio
    // as an escaped blob. The issues already carry the sentence.
    if (err instanceof z.ZodError) {
      return c.json({ error: formatSchemaIssues(err.issues) }, 400);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: err.message }, 400);
    }
    // Cross-replica slug-lock contention: another replica holds the lease.
    // A retryable conflict, not a server fault.
    if (err instanceof SlugLockTimeoutError) {
      return c.json({ error: err.message }, 409);
    }
    // A sandbox that would not start: infrastructure, not a server fault, and
    // retryable. Logged at warn with the backend's own message + cause chain,
    // so the diagnosis (`Sandbox operation timed out`, `guest never came up`,
    // …) keeps landing in the log while the caller gets a sentence it can act
    // on. Answering 500 here also cost the studio client its retry: it treats
    // 5xx as transient, but "Internal server error" is what the user was left
    // staring at once the retries ran out.
    if (err instanceof SandboxUnavailableError) {
      log.warn(`sandbox unavailable on ${c.req.path}`, { detail: errorDetail(err) });
      return c.json({ error: SANDBOX_UNAVAILABLE_MESSAGE }, 503);
    }
    // The platform's own Postgres, unreachable: infrastructure, not a server
    // fault, and retryable — so 503, which the studio client already treats as
    // transient. Answering 500 cost it that retry and told the user "Internal
    // server error" for 20 minutes while the real reason (a connection string
    // naming a host with no A record) sat in the detail.
    //
    // `error` rather than `warn`, unlike a sandbox at capacity: a platform
    // database this process cannot reach is never ordinary — it is a
    // misconfiguration or an outage, and EVERY stateful request is failing
    // alongside this one. The cause chain carries the driver's code and the
    // host it could not reach, which is the whole diagnosis.
    if (err instanceof PlatformDbUnavailableError) {
      log.error(`platform database unreachable on ${c.req.path}`, { cause: causeChain(err) });
      return c.json({ error: PLATFORM_DB_UNAVAILABLE_MESSAGE }, 503);
    }
    log.error(`unhandled error on ${c.req.path}`, { detail: errorDetail(err) });
    return c.json({ error: "Internal server error" }, 500);
  };
}
