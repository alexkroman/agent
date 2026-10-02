// Copyright 2026 the AAI authors. MIT license.
/**
 * The gate on its own, over a real `IncomingMessage`/`ServerResponse` pair.
 *
 * `manage.test.ts` drives the same gate through `createAgentRequestHandler`,
 * which is what pins that the deployed guest's request hook WIRES it; this file
 * pins the predicate itself, including the paths it must leave alone.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test } from "vitest";
import { GUEST_PROXY_TOKEN_HEADER, gateDirectWorkflowDial } from "./workflow-gate.ts";

const TOKEN = "a".repeat(64);

/** A request carrying `token` in the proxy header, or no header when undefined. */
function request(token?: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  if (token !== undefined) req.headers[GUEST_PROXY_TOKEN_HEADER] = token;
  return req;
}

/** Run the gate and report whether it answered, and with what status. */
function dial(url: string, token: string | undefined, expected = TOKEN) {
  const req = request(token);
  const res = new ServerResponse(req);
  const answered = gateDirectWorkflowDial(req, res, url, expected);
  return { answered, status: answered ? res.statusCode : undefined };
}

describe("gateDirectWorkflowDial", () => {
  test.each(["/workflows", "/workflows/runs", "/workflows/runs/abc/events"])(
    "answers 401 for %s with no proxy token",
    (url) => {
      expect(dial(url, undefined)).toEqual({ answered: true, status: 401 });
    },
  );

  test.each([
    "/workflowsx",
    "/websocket",
    "/.well-known/workflow/v1/webhook/tok",
    "/workflow-queue",
  ])("leaves %s to whatever serves it", (url) => {
    expect(dial(url, undefined)).toEqual({ answered: false, status: undefined });
  });

  test("the platform's token falls through to the runtime's own API", () => {
    expect(dial("/workflows/runs", TOKEN)).toEqual({ answered: false, status: undefined });
  });

  test.each([
    ["a wrong token", "b".repeat(64), TOKEN],
    ["an empty header against a real token", "", TOKEN],
    ["an empty header against a blank token", "", ""],
    ["a whitespace header against a whitespace token", "  ", "  "],
  ])("refuses %s", (_label, supplied, expected) => {
    expect(dial("/workflows/runs", supplied, expected)).toEqual({ answered: true, status: 401 });
  });
});
