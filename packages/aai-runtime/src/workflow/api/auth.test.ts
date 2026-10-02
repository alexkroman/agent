// Copyright 2026 the AAI authors. MIT license.
// The workflow API's bearer gate: open when no token is configured, a 401
// for anything but the configured one.

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { WORKFLOW_API_TOKEN_ENV, workflowApiUnauthorized } from "./auth.ts";

function exchange(authorization?: string) {
  const req = new IncomingMessage(new Socket());
  if (authorization !== undefined) req.headers = { authorization };
  const res = new ServerResponse(req);
  const writeHead = vi.spyOn(res, "writeHead");
  return { req, res, status: () => writeHead.mock.calls[0]?.[0] };
}

describe("workflowApiUnauthorized", () => {
  test("no configured token leaves the API open", () => {
    const { req, res, status } = exchange();
    expect(workflowApiUnauthorized(req, res, undefined)).toBe(false);
    expect(status()).toBeUndefined();
  });

  test("the configured bearer passes and writes nothing", () => {
    const { req, res, status } = exchange("Bearer s3cret");
    expect(workflowApiUnauthorized(req, res, "s3cret")).toBe(false);
    expect(status()).toBeUndefined();
  });

  test.each([
    ["no header", undefined],
    ["a wrong token", "Bearer nope"],
    ["a non-bearer scheme", "Basic s3cret"],
  ])("%s is answered 401 and reported as handled", (_label, header) => {
    const { req, res, status } = exchange(header);
    expect(workflowApiUnauthorized(req, res, "s3cret")).toBe(true);
    expect(status()).toBe(401);
  });
});

test("the env key keeps its name, which operators set", () => {
  expect(WORKFLOW_API_TOKEN_ENV).toBe("AAI_WORKFLOW_API_TOKEN");
});
