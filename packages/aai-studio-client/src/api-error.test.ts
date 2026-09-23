// Copyright 2026 the AAI authors. MIT license.
// The studio's failure vocabulary: the busy/broken split every gate screen
// words itself from, and the displayable text of an arbitrary rejection.

import { describe, expect, test } from "vitest";
import { ApiError, errorText, isTransientError } from "./api-error.ts";

describe("ApiError", () => {
  test("is an Error carrying the status and message", () => {
    const err = new ApiError(404, "Project not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Project not found");
  });
});

describe("isTransientError", () => {
  test.each([400, 401, 403, 404, 409, 422, 499])(
    "a %i is a real answer, not worth retrying",
    (status) => {
      expect(isTransientError(new ApiError(status, "no"))).toBe(false);
    },
  );

  test.each([408, 429])("a %i is the transient kind of 4xx", (status) => {
    expect(isTransientError(new ApiError(status, "later"))).toBe(true);
  });

  test.each([500, 502, 503, 504])("a %i means the server was not ready", (status) => {
    expect(isTransientError(new ApiError(status, "busy"))).toBe(true);
  });

  test("a rejected fetch and a timed-out attempt are transient", () => {
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientError(new DOMException("signal timed out", "TimeoutError"))).toBe(true);
  });

  test("a non-Error rejection is transient too — it is not a server answer", () => {
    expect(isTransientError("boom")).toBe(true);
    expect(isTransientError({ status: 404 })).toBe(true);
  });
});

describe("errorText", () => {
  test("no error, no text", () => {
    expect(errorText(null)).toBeUndefined();
    expect(errorText(undefined)).toBeUndefined();
  });

  test("an Error reads as its message", () => {
    expect(errorText(new ApiError(401, "Invalid API key"))).toBe("Invalid API key");
  });

  test("a message-bearing non-Error is not rendered as [object Object]", () => {
    const text = errorText({ message: "sandbox unavailable" });
    expect(text).not.toBe("[object Object]");
    expect(text).toContain("sandbox unavailable");
  });

  test("a bare string reads as itself", () => {
    expect(errorText("nope")).toBe("nope");
  });
});
