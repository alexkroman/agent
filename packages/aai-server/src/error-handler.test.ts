// Copyright 2025 the AAI authors. MIT license.

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createErrorHandler } from "./error-handler.ts";

function throwError(err: Error): never {
  throw err;
}

function createApp(opts?: { exposeErrors?: boolean }) {
  const app = new Hono();
  app.get("/http-error", () => throwError(new HTTPException(403, { message: "Forbidden" })));
  app.get("/zod-error", () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 123 });
    if (!result.success) throw result.error;
    return new Response();
  });
  app.get("/syntax-error", () => throwError(new SyntaxError("Unexpected token")));
  app.get("/unknown-error", () => throwError(new Error("something broke")));
  app.onError(createErrorHandler(opts));
  return app;
}

describe("createErrorHandler", () => {
  test("returns HTTPException status and message", async () => {
    const res = await createApp().request("/http-error");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  test("returns 400 for ZodError", async () => {
    const res = await createApp().request("/zod-error");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  test("returns 400 for SyntaxError", async () => {
    const res = await createApp().request("/syntax-error");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Unexpected token" });
  });

  test("returns generic 500 for unknown errors by default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await createApp().request("/unknown-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });

  test("exposes error message when exposeErrors is true", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await createApp({ exposeErrors: true }).request("/unknown-error");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "something broke" });
  });
});
