// Copyright 2025 the AAI authors. MIT license.

import { errorDetail } from "@alexkroman1/aai";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { SlugLockTimeoutError } from "./platform-lock.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";

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
 * Shared Hono error handler for the platform services. Unhandled errors are
 * logged with full detail but answered with an opaque 500 — raw messages
 * can leak internals to unauthenticated callers.
 */
export function createErrorHandler(): ErrorHandler {
  return (err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError || err instanceof SyntaxError) {
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
      console.warn(`Sandbox unavailable on ${c.req.path}: ${errorDetail(err)}`);
      return c.json({ error: SANDBOX_UNAVAILABLE_MESSAGE }, 503);
    }
    console.error(`Unhandled error on ${c.req.path}: ${errorDetail(err)}`);
    return c.json({ error: "Internal server error" }, 500);
  };
}
