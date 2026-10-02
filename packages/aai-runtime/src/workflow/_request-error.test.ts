// Copyright 2026 the AAI authors. MIT license.
// The failure a workflow caller can FIX, told apart by type.

import { expect, test } from "vitest";
import { isWorkflowRequestError, WorkflowRequestError } from "./_request-error.ts";

test("a WorkflowRequestError is an Error with its own name and the caller's message", () => {
  const err = new WorkflowRequestError('Workflow "nope" is not declared');
  expect(err).toBeInstanceOf(Error);
  expect(err.name).toBe("WorkflowRequestError");
  expect(err.message).toBe('Workflow "nope" is not declared');
});

test("isWorkflowRequestError answers for the class and nothing else", () => {
  expect(isWorkflowRequestError(new WorkflowRequestError("bad input"))).toBe(true);
  // A store outage carrying a look-alike name is still OURS — a 500, never a 400.
  const lookalike = Object.assign(new Error("connect ECONNREFUSED"), {
    name: "WorkflowRequestError",
  });
  expect(isWorkflowRequestError(lookalike)).toBe(false);
  expect(isWorkflowRequestError("bad input")).toBe(false);
  expect(isWorkflowRequestError(undefined)).toBe(false);
});
