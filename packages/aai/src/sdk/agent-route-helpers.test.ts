// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";
import { createStubWorkflows } from "./_testing-context.ts";
import { RouteError, readRouteError, route, routeError } from "./agent-route-helpers.ts";
import { type RouteContext, type RouteRequest, readRouteResponse } from "./agent-routes.ts";

const ctx: RouteContext = {
  env: {},
  workflows: createStubWorkflows(),
  clientTranscript: async () => ({ sessions: [] }),
  signal: new AbortController().signal,
};

function req(over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    method: "POST",
    path: "/x",
    params: {},
    query: {},
    headers: {},
    body: undefined,
    ...over,
  };
}

describe("routeError", () => {
  test("carries a 4xx/5xx status and is read back by the brand", () => {
    const err = routeError(400, "name: text up to 80");
    expect(err).toBeInstanceOf(RouteError);
    expect(err).toBeInstanceOf(Error);
    expect(readRouteError(err)).toEqual({ status: 400, message: "name: text up to 80" });
    expect(Object.keys(err)).not.toContain(String(Symbol.for("@alexkroman1/aai.routeError")));
  });

  test("a status that is not 4xx or 5xx fails where it was written", () => {
    for (const status of [200, 302, 399, 600, 400.5]) {
      expect.soft(() => routeError(status, "x"), String(status)).toThrow(RangeError);
    }
  });

  test("an ordinary error, or a forged brand out of range, is not a route error", () => {
    expect(readRouteError(new Error("boom"))).toBeUndefined();
    expect(readRouteError({ status: 400, message: "x" })).toBeUndefined();
    const forged = { status: 200, message: "x" };
    Object.defineProperty(forged, Symbol.for("@alexkroman1/aai.routeError"), { value: true });
    expect(readRouteError(forged)).toBeUndefined();
  });

  test("one made by ANOTHER copy of the module is recognized — the bundle's, say", async () => {
    vi.resetModules();
    const other = await import("./agent-route-helpers.ts");
    expect(other.routeError).not.toBe(routeError);
    expect(readRouteError(other.routeError(409, "taken"))).toEqual({
      status: 409,
      message: "taken",
    });
  });
});

describe("route", () => {
  const schema = z.object({ name: z.string().max(5) });

  test("validates the body and hands the handler the schema's output", async () => {
    const handler = route({
      body: schema.transform((b) => ({ ...b, upper: b.name.toUpperCase() })),
      handler: (r) => {
        expectTypeOf(r.body).toEqualTypeOf<{ name: string; upper: string }>();
        return r.body;
      },
    });
    expect(await handler(req({ body: { name: "ann" } }), ctx)).toEqual({
      name: "ann",
      upper: "ANN",
    });
  });

  test("a refused or missing body is a 400 naming the issue, and the handler never runs", async () => {
    const inner = vi.fn();
    const handler = route({ body: schema, handler: inner });
    const refused = readRouteResponse(await handler(req({ body: { name: "too long" } }), ctx));
    expect(refused?.status).toBe(400);
    expect((refused?.body as { error: string } | undefined)?.error).toMatch(
      /^Invalid request body: name/,
    );
    expect(readRouteResponse(await handler(req(), ctx))?.status).toBe(400);
    expect(inner).not.toHaveBeenCalled();
  });

  test("requireClient refuses a request without ?client= and types clientId as a string", async () => {
    const handler = route({
      requireClient: true,
      handler: (r) => {
        expectTypeOf(r.clientId).toEqualTypeOf<string>();
        return { client: r.clientId };
      },
    });
    expect(readRouteResponse(await handler(req(), ctx))).toEqual({
      status: 400,
      body: { error: "?client= is required" },
    });
    expect(await handler(req({ clientId: "kitchen" }), ctx)).toEqual({ client: "kitchen" });
  });

  test("a RouteError thrown inside answers its status; any other throw propagates", async () => {
    const refusing = route({
      handler: () => {
        throw routeError(404, "no such app");
      },
    });
    expect(readRouteResponse(await refusing(req(), ctx))).toEqual({
      status: 404,
      body: { error: "no such app" },
    });
    const crashing = route({
      handler: () => {
        throw new Error("boom");
      },
    });
    await expect(crashing(req(), ctx)).rejects.toThrow("boom");
  });

  test("without a schema the body passes through untouched and clientId stays optional", async () => {
    const handler = route({
      handler: (r) => {
        expectTypeOf(r.clientId).toEqualTypeOf<string | undefined>();
        return r.body;
      },
    });
    expect(await handler(req({ body: [1, 2] }), ctx)).toEqual([1, 2]);
  });
});
