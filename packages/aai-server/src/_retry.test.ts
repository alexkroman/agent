// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { isTransientNetworkError, retryOnTransient } from "./_retry.ts";

describe("isTransientNetworkError", () => {
  test("recognises direct ECONNRESET", () => {
    const err = Object.assign(new Error("boom"), { code: "ECONNRESET" });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  test("walks the cause chain (fetch() wraps the real error)", () => {
    const root = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const fetchErr = Object.assign(new TypeError("fetch failed"), { cause: root });
    expect(isTransientNetworkError(fetchErr)).toBe(true);
  });

  test("ignores non-transient errors", () => {
    expect(isTransientNetworkError(new Error("nope"))).toBe(false);
    expect(isTransientNetworkError(Object.assign(new Error("403"), { code: "EACCES" }))).toBe(
      false,
    );
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError("string")).toBe(false);
  });

  test("handles cyclic cause chains without spinning", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isTransientNetworkError(a)).toBe(false);
  });
});

describe("retryOnTransient", () => {
  test("returns the value on first success", async () => {
    const op = vi.fn().mockResolvedValue(42);
    await expect(retryOnTransient(op)).resolves.toBe(42);
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("retries on ECONNRESET and eventually succeeds", async () => {
    const transient = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const op = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce("ok");

    const onRetry = vi.fn();
    await expect(retryOnTransient(op, { baseDelayMs: 1, onRetry })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test("does not retry non-transient errors", async () => {
    const op = vi.fn().mockRejectedValue(new Error("404"));
    await expect(retryOnTransient(op, { baseDelayMs: 1 })).rejects.toThrow("404");
    expect(op).toHaveBeenCalledTimes(1);
  });

  test("gives up after `attempts` transient failures", async () => {
    const transient = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    const op = vi.fn().mockRejectedValue(transient);
    await expect(retryOnTransient(op, { attempts: 3, baseDelayMs: 1 })).rejects.toBe(transient);
    expect(op).toHaveBeenCalledTimes(3);
  });
});
