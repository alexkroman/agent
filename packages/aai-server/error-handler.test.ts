// Copyright 2025 the AAI authors. MIT license.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  createErrorHandler,
  PLATFORM_DB_UNAVAILABLE_MESSAGE,
  SANDBOX_UNAVAILABLE_MESSAGE,
} from "./error-handler.ts";
import { PlatformDbUnavailableError } from "./platform-db-errors.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { captureLogs } from "./test-utils.ts";

function throwError(err: Error): never {
  throw err;
}

function createApp() {
  const app = new Hono();
  app.get("/http-error", () => throwError(new HTTPException(403, { message: "Forbidden" })));
  app.get("/zod-error", () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 123 });
    if (!result.success) throw result.error;
    return new Response();
  });
  app.get("/syntax-error", () => throwError(new SyntaxError("Unexpected token")));
  app.get("/unknown-error", () => throwError(new Error("something broke")));
  app.get("/unavailable", () =>
    throwError(
      new HTTPException(503, {
        message: "This agent is not available right now — try again.",
        cause: new Error("the forward was aborted", {
          cause: new Error("This operation was aborted"),
        }),
      }),
    ),
  );
  app.get("/sandbox-unavailable", () =>
    throwError(
      new SandboxUnavailableError("Modal sandbox spawn failed: Sandbox operation timed out", {
        cause: new Error("Sandbox operation timed out"),
      }),
    ),
  );
  app.get("/db-unavailable", () =>
    throwError(
      new PlatformDbUnavailableError("getaddrinfo ENOTFOUND db.ref.supabase.co", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND db.ref.supabase.co"), {
          code: "ENOTFOUND",
        }),
      }),
    ),
  );
  app.onError(createErrorHandler());
  return app;
}

describe("createErrorHandler", () => {
  const logs = captureLogs();

  test("returns HTTPException status and message", async () => {
    const res = await createApp().request("/http-error");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  test("logs a 5xx HTTPException's whole cause chain, which is the diagnosis", async () => {
    // The message is written FOR THE CALLER and the stack names the throw site, so
    // neither says which condition produced the 503. Before this, 27 upload `PUT`s
    // answered 503 in one hour of production log with no server-side line at all.
    const res = await createApp().request("/unavailable");
    expect(res.status).toBe(503);
    const logged = logs
      .all()
      .map((line) => `${line.msg} ${JSON.stringify(line.ctx ?? {})}`)
      .join("\n");
    expect(logged).toContain("503 on /unavailable");
    expect(logged).toContain("the forward was aborted");
    expect(logged).toContain("This operation was aborted");
  });

  test("a 4xx HTTPException stays quiet — it is about the CALLER's request", async () => {
    const res = await createApp().request("/http-error");
    expect(res.status).toBe(403);
    expect(logs.all()).toEqual([]);
  });

  // `toBeTruthy()` was the whole assertion here, and a 2-line JSON blob is
  // truthy: a ZodError's own `message` is `JSON.stringify(issues, null, 2)`,
  // which is what this route shipped for as long as the test only asked
  // whether SOMETHING came back.
  test("returns 400 for ZodError, as one sentence rather than a JSON dump", async () => {
    const res = await createApp().request("/zod-error");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("name: Invalid input: expected string, received number");
    expect(body.error).not.toContain("\n");
    expect(body.error).not.toContain('"code"');
  });

  test("returns 400 for SyntaxError", async () => {
    const res = await createApp().request("/syntax-error");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unexpected token" });
  });

  test("returns a retryable 503 for a sandbox that would not start", async () => {
    const res = await createApp().request("/sandbox-unavailable");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SANDBOX_UNAVAILABLE_MESSAGE });
    // Not "Unhandled": a spawn failure is infrastructure, not a server fault.
    expect(logs.errors()).toEqual([]);
    // The backend's own diagnosis still reaches the log.
    expect(JSON.stringify(logs.all())).toContain("Sandbox operation timed out");
  });

  test("returns a retryable 503 when the platform database is unreachable", async () => {
    // This answered 500 with `unhandled error on /studio/account` for 20+ minutes
    // of production while the reason — a connection string naming a host with no
    // A record — sat in the detail. The studio client retries 5xx, so the 500
    // also cost it the retry and left "Internal server error" on screen.
    const res = await createApp().request("/db-unavailable");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: PLATFORM_DB_UNAVAILABLE_MESSAGE });
    // The hostname is ours, so it stays out of the body and in the log.
    expect(body.error).not.toContain("supabase.co");
    const logged = JSON.stringify(logs.all());
    expect(logged).toContain("platform database unreachable on /db-unavailable");
    expect(logged).toContain("ENOTFOUND db.ref.supabase.co");
  });

  test("returns generic 500 for unknown errors", async () => {
    const res = await createApp().request("/unknown-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});
