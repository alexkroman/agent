// Copyright 2025 the AAI authors. MIT license.

import { errorDetail, errorMessage } from "@alexkroman1/aai";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

/**
 * Shared Hono error handler for the platform server and sidecars.
 *
 * @param opts.exposeErrors - When true, return the original error message
 *   in 500 responses. Safe for loopback-only services like the sidecar.
 */
export function createErrorHandler(opts?: { exposeErrors?: boolean }): ErrorHandler {
  return (err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError || err instanceof SyntaxError) {
      return c.json({ error: err.message }, 400);
    }
    console.error(`Unhandled error on ${c.req.path}: ${errorDetail(err)}`);
    return c.json({ error: opts?.exposeErrors ? errorMessage(err) : "Internal server error" }, 500);
  };
}
