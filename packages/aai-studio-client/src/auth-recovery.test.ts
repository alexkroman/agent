// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The one answer to a rejected bearer: refresh, once per distinct rejection,
// at most `maxAttempts` times, then hand off to `onExhausted`.

import { renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "./api-error.ts";
import { authRejection, useAuthRecovery } from "./auth-recovery.ts";

describe("authRejection", () => {
  test("picks the first 401 among the errors", () => {
    const first = new ApiError(401, "expired");
    const second = new ApiError(401, "also expired");
    expect(authRejection(undefined, new ApiError(500, "x"), first, second)).toBe(first);
  });

  test("anything but a 401 ApiError is not a rejected bearer", () => {
    expect(
      authRejection(
        null,
        undefined,
        new ApiError(403, "forbidden"),
        new ApiError(500, "down"),
        new Error("401"),
        { status: 401 },
      ),
    ).toBeUndefined();
  });

  test("no errors, no rejection", () => {
    expect(authRejection()).toBeUndefined();
  });
});

function setup(opts: { maxAttempts?: number } = {}) {
  const refresh = vi.fn(async () => undefined);
  const onExhausted = vi.fn();
  const hook = renderHook(
    ({ rejection }: { rejection: unknown }) =>
      useAuthRecovery(rejection, refresh, { ...opts, onExhausted }),
    { initialProps: { rejection: undefined as unknown } },
  );
  return { refresh, onExhausted, ...hook };
}

describe("useAuthRecovery", () => {
  test("does nothing while there is no rejection", () => {
    const { refresh, onExhausted, rerender } = setup();
    rerender({ rejection: undefined });
    rerender({ rejection: null });
    expect(refresh).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  test("refreshes once per rejection, not once per render", () => {
    const { refresh, rerender } = setup();
    const rejection = new ApiError(401, "expired");
    rerender({ rejection });
    rerender({ rejection });
    rerender({ rejection });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("a NEW rejection after a failed recovery re-arms it", () => {
    const { refresh, rerender } = setup();
    rerender({ rejection: new ApiError(401, "one") });
    rerender({ rejection: undefined });
    rerender({ rejection: new ApiError(401, "two") });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test("past the cap it stops refreshing and calls onExhausted", () => {
    const { refresh, onExhausted, rerender } = setup();
    rerender({ rejection: new ApiError(401, "1") });
    rerender({ rejection: new ApiError(401, "2") });
    expect(onExhausted).not.toHaveBeenCalled();
    rerender({ rejection: new ApiError(401, "3") });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  test("honours a custom cap", () => {
    const { refresh, onExhausted, rerender } = setup({ maxAttempts: 1 });
    rerender({ rejection: new ApiError(401, "1") });
    rerender({ rejection: new ApiError(401, "2") });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  test("StrictMode's double-invoked effect does not burn two attempts on one rejection", () => {
    const refresh = vi.fn(async () => undefined);
    const rejection = new ApiError(401, "expired");
    renderHook(() => useAuthRecovery(rejection, refresh), { wrapper: StrictMode });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("calls the LATEST onExhausted, not the one from the first render", () => {
    const refresh = vi.fn(async () => undefined);
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = renderHook(
      ({ rejection, onExhausted }: { rejection: unknown; onExhausted: () => void }) =>
        useAuthRecovery(rejection, refresh, { maxAttempts: 0, onExhausted }),
      { initialProps: { rejection: undefined as unknown, onExhausted: first } },
    );
    rerender({ rejection: new ApiError(401, "x"), onExhausted: latest });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
