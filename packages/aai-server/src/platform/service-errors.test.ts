// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  isStorageUnavailable,
  isUnavailableStatus,
  PlatformServiceUnavailableError,
  storageFailureCause,
} from "./service-errors.ts";

describe("PlatformServiceUnavailableError", () => {
  test("names the service and keeps the cause", () => {
    const cause = new Error("ECONNRESET");
    const err = new PlatformServiceUnavailableError("storage", "storage unreachable", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PlatformServiceUnavailableError");
    expect(err.service).toBe("storage");
    expect(err.message).toBe("storage unreachable");
    expect(err.cause).toBe(cause);
  });
});

describe("isUnavailableStatus", () => {
  test.each([429, 500, 502, 503, 504])("%d is the dependency's outage", (status) => {
    expect(isUnavailableStatus(status)).toBe(true);
  });

  test.each([200, 400, 401, 403, 404, 409])("%d is an answer, not an outage", (status) => {
    expect(isUnavailableStatus(status)).toBe(false);
  });
});

describe("isStorageUnavailable", () => {
  test("reads either spelling of the status", () => {
    expect(isStorageUnavailable({ status: 503 })).toBe(true);
    expect(isStorageUnavailable({ statusCode: "502" })).toBe(true);
    expect(isStorageUnavailable({ status: 404 })).toBe(false);
    expect(isStorageUnavailable({ statusCode: 400 })).toBe(false);
  });

  test("no usable status means no response arrived, which is retryable", () => {
    expect(isStorageUnavailable({ message: "fetch failed" })).toBe(true);
    expect(isStorageUnavailable({ status: "teapot" })).toBe(true);
  });

  test("a non-object is not classified as unavailable", () => {
    expect(isStorageUnavailable("boom")).toBe(false);
    expect(isStorageUnavailable(undefined)).toBe(false);
  });
});

describe("storageFailureCause", () => {
  test("unwraps the SDK's originalError, and passes anything else through", () => {
    const original = new TypeError("fetch failed");
    expect(storageFailureCause({ originalError: original, status: 500 })).toBe(original);
    const plain = { status: 500 };
    expect(storageFailureCause(plain)).toBe(plain);
    expect(storageFailureCause("text")).toBe("text");
  });
});
