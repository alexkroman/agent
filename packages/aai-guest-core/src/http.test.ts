// Copyright 2026 the AAI authors. MIT license.
/**
 * The one JSON responder the guest's HTTP surfaces share. What its callers
 * rely on: the status and a JSON content type are written together, the body
 * is exactly `JSON.stringify(body)`, and the default carries NO extra headers —
 * CORS is the browser-facing studio surface's opt-in, never a platform route's.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { writeJson } from "./http.ts";

/**
 * A real `ServerResponse` on an unconnected socket, with the two calls
 * `writeJson` makes recorded and stubbed — nothing is written anywhere.
 */
function fakeResponse() {
  const calls: { head?: [number, Record<string, string>]; end?: string } = {};
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  vi.spyOn(res, "writeHead").mockImplementation((status, headers) => {
    calls.head = [status, headers as Record<string, string>];
    return res;
  });
  vi.spyOn(res, "end").mockImplementation((chunk?: unknown) => {
    calls.end = chunk as string;
    return res;
  });
  return { res, calls };
}

describe("writeJson", () => {
  test("writes the status, a JSON content type, and the serialized body", () => {
    const { res, calls } = fakeResponse();
    writeJson(res, 401, { error: "unauthorized" });
    expect(calls.head).toEqual([401, { "Content-Type": "application/json" }]);
    expect(calls.end).toBe('{"error":"unauthorized"}');
  });

  test("the default is BARE — no CORS header leaks onto a platform route", () => {
    const { res, calls } = fakeResponse();
    writeJson(res, 200, { ok: true });
    expect(Object.keys(calls.head?.[1] ?? {})).toEqual(["Content-Type"]);
  });

  test("extra headers are merged alongside the content type", () => {
    const { res, calls } = fakeResponse();
    writeJson(res, 204, null, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    expect(calls.head).toEqual([
      204,
      {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    ]);
    expect(calls.end).toBe("null");
  });

  test("a caller's headers override the content type when it names one", () => {
    const { res, calls } = fakeResponse();
    writeJson(res, 200, [], { "Content-Type": "application/problem+json" });
    expect(calls.head?.[1]).toEqual({ "Content-Type": "application/problem+json" });
  });

  test.each([
    ["an array", [1, "two", { three: 3 }]],
    ["a string", "hello"],
    ["a number", 42],
    ["unicode", { msg: "héllo — ✓" }],
  ])("serializes %s exactly as JSON.stringify does", (_label, body) => {
    const { res, calls } = fakeResponse();
    writeJson(res, 200, body);
    expect(calls.end).toBe(JSON.stringify(body));
    expect(JSON.parse(calls.end ?? "")).toEqual(body);
  });
});
