// Copyright 2026 the AAI authors. MIT license.
// `runIdOr400` on its own: the decoded id, or the answer it already sent.
//
// `api/run-id.test.ts` drives the same rules through a real server; these pin
// the function's own contract — what it returns and what it wrote.

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { runIdOr400 } from "./_run-id.ts";

const PREFIX = "/workflows/runs/";

function response() {
  const res = new ServerResponse(new IncomingMessage(new Socket()));
  const writeHead = vi.spyOn(res, "writeHead");
  const end = vi.spyOn(res, "end");
  const answered = () => ({
    status: writeHead.mock.calls[0]?.[0],
    body:
      end.mock.calls[0]?.[0] === undefined ? undefined : JSON.parse(String(end.mock.calls[0][0])),
  });
  return { res, answered };
}

describe("runIdOr400", () => {
  test("answers the decoded id and writes nothing", () => {
    const { res, answered } = response();
    expect(runIdOr400(res, `${PREFIX}wrun_01ABC`, PREFIX)).toBe("wrun_01ABC");
    expect(answered().status).toBeUndefined();
  });

  test("strips a route suffix before reading the id", () => {
    const { res } = response();
    expect(runIdOr400(res, `${PREFIX}wrun_1/events`, PREFIX, "/events")).toBe("wrun_1");
  });

  test("a further literal segment is a 404 — a route this path does not have", () => {
    const { res, answered } = response();
    expect(runIdOr400(res, `${PREFIX}wrun_1/frobnicate`, PREFIX)).toBeUndefined();
    expect(answered()).toEqual({ status: 404, body: { error: "Not found" } });
  });

  test("a malformed escape is a 400 naming it", () => {
    const { res, answered } = response();
    expect(runIdOr400(res, `${PREFIX}%zz`, PREFIX)).toBeUndefined();
    expect(answered()).toEqual({ status: 400, body: { error: "Malformed run id" } });
  });

  test.each(["", "wrun_..", "wrun_a%2Fb", "wrun_a%5Cb"])(
    "%j is an id no store can hold: 400",
    (raw) => {
      const { res, answered } = response();
      expect(runIdOr400(res, `${PREFIX}${raw}`, PREFIX)).toBeUndefined();
      expect(answered().status).toBe(400);
      expect(answered().body.error).toMatch(/may not be empty or contain/);
    },
  );
});
