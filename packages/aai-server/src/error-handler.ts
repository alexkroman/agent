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
import { PlatformServiceUnavailableError } from "./platform-service-errors.ts";
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
 * What a caller is told when a platform dependency reached over HTTP was
 * unavailable — Supabase Auth or Supabase Storage.
 *
 * Deliberately does NOT name which one, on the same rule as the two messages
 * above: the caller cannot act on the difference and an unauthenticated one
 * should not learn our topology. The `service` field is what the log carries,
 * because that difference IS actionable to an operator.
 */
export const PLATFORM_SERVICE_UNAVAILABLE_MESSAGE =
  "The platform is temporarily unable to reach one of its services, so this request could not be served. Try again shortly.";

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
 * The dependency-unavailable cases: log the diagnosis, return the sentence the
 * caller gets, or `undefined` when this is not one of them.
 *
 * Three classes, one status, and grouping them is what keeps that true —
 * a 503 is the whole point of each, so a fourth dependency arriving with a 500
 * (which is what all three used to do) should not be possible to write. The
 * SPLIT that matters is the log LEVEL, and it is a judgement per dependency
 * rather than a default:
 *
 * - A sandbox at capacity is ORDINARY. `warn`.
 * - A platform database or service this process cannot reach is not: it is a
 *   misconfiguration or an outage, and every stateful request is failing
 *   alongside this one. `error`.
 *
 * Answering 500 for any of them also cost the studio client its retry — it
 * treats 5xx as transient, and "Internal server error" is what the user was
 * left staring at once the retries ran out.
 */
function reportUnavailable(err: unknown, path: string): string | undefined {
  // The backend's own message plus its cause chain (`Sandbox operation timed
  // out`, `guest never came up`, …) keeps landing in the log while the caller
  // gets a sentence it can act on.
  if (err instanceof SandboxUnavailableError) {
    log.warn(`sandbox unavailable on ${path}`, { detail: errorDetail(err) });
    return SANDBOX_UNAVAILABLE_MESSAGE;
  }
  // The cause chain carries the driver's code and the host it could not reach,
  // which is the whole diagnosis — production spent 20 minutes answering 500
  // with `getaddrinfo ENOTFOUND db.<ref>.supabase.co` sitting in the detail.
  if (err instanceof PlatformDbUnavailableError) {
    log.error(`platform database unreachable on ${path}`, { cause: causeChain(err) });
    return PLATFORM_DB_UNAVAILABLE_MESSAGE;
  }
  // Supabase Auth or Supabase Storage. The `service` is its own log field
  // rather than part of the message, because it is what decides where an
  // operator looks — "auth is down" and "storage is down" are different
  // dashboards, and neither library's message says which it was.
  if (err instanceof PlatformServiceUnavailableError) {
    log.error(`platform service ${err.service} unavailable on ${path}`, {
      cause: causeChain(err),
    });
    return PLATFORM_SERVICE_UNAVAILABLE_MESSAGE;
  }
  return undefined;
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
    // A DEPENDENCY was unavailable — every one of them is a retryable 503, and
    // they share one branch so a fourth cannot arrive with a different status.
    const unavailable = reportUnavailable(err, c.req.path);
    if (unavailable !== undefined) return c.json({ error: unavailable }, 503);
    log.error(`unhandled error on ${c.req.path}`, { detail: errorDetail(err) });
    return c.json({ error: "Internal server error" }, 500);
  };
}
