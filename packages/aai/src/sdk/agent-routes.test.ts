// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { readRouteResponse, routeResponse } from "./agent-routes.ts";

describe("routeResponse", () => {
  test("carries its status and body, and the brand never reaches JSON", () => {
    const answer = routeResponse(404, { error: "No such memory" });
    expect(answer).toEqual({ status: 404, body: { error: "No such memory" } });
    expect(JSON.stringify(answer)).toBe('{"status":404,"body":{"error":"No such memory"}}');
    expect(readRouteResponse(answer)).toEqual({ status: 404, body: { error: "No such memory" } });
  });

  test("a status that is not 2xx, 4xx or 5xx fails where it was written", () => {
    for (const status of [100, 199, 302, 399, 600, 200.5, Number.NaN]) {
      expect.soft(() => routeResponse(status), String(status)).toThrow(RangeError);
    }
    expect(routeResponse(204).status).toBe(204);
    expect(routeResponse(422, { error: "bad" }).status).toBe(422);
  });

  test("a plain object shaped like one is a 200 body, not a status", () => {
    expect(readRouteResponse({ status: 201, body: "x" })).toBeUndefined();
    expect(readRouteResponse("created")).toBeUndefined();
    expect(readRouteResponse(undefined)).toBeUndefined();
  });

  test("a forged brand with a status out of range is not trusted", () => {
    const forged = { status: 99, body: null };
    Object.defineProperty(forged, Symbol.for("@alexkroman1/aai.routeResponse"), { value: true });
    expect(readRouteResponse(forged)).toBeUndefined();
  });

  test("a response made by ANOTHER copy of the module is recognized — the bundle's, say", async () => {
    vi.resetModules();
    const other = await import("./agent-routes.ts");
    expect(other.routeResponse).not.toBe(routeResponse);
    expect(readRouteResponse(other.routeResponse(201, { id: 7 }))).toEqual({
      status: 201,
      body: { id: 7 },
    });
  });
});
