// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The press-to-settle stopwatch both submit hooks report as `timing`.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useSubmissionTiming } from "./_submission-timing.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Drive `pending` from the outside, the way a hook's own flag moves. */
function mount(initial = false) {
  return renderHook(({ pending }) => useSubmissionTiming(pending), {
    initialProps: { pending: initial },
  });
}

describe("useSubmissionTiming", () => {
  test("has no marks before the first press", () => {
    const { result } = mount();
    expect(result.current.timing).toEqual({});
  });

  test("marks the press, then the settle once pending has fallen, in that order", () => {
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    const hook = mount();
    act(() => hook.result.current.markSubmitted());
    expect(hook.result.current.timing).toEqual({ submittedAt: 1000 });

    hook.rerender({ pending: true });
    expect(hook.result.current.timing.settledAt).toBeUndefined();

    now.mockReturnValue(4200);
    hook.rerender({ pending: false });
    expect(hook.result.current.timing).toEqual({ submittedAt: 1000, settledAt: 4200 });
  });

  test("a press that lands before pending is seen true does not settle at zero", () => {
    // A render in between — pending still false — must not read as "settled".
    const hook = mount();
    act(() => hook.result.current.markSubmitted());
    hook.rerender({ pending: false });
    expect(hook.result.current.timing.settledAt).toBeUndefined();
    hook.rerender({ pending: true });
    hook.rerender({ pending: false });
    expect(hook.result.current.timing.settledAt).toBeTypeOf("number");
  });

  test("a second press restarts the clock, and clear drops both marks", () => {
    const hook = mount();
    act(() => hook.result.current.markSubmitted());
    hook.rerender({ pending: true });
    hook.rerender({ pending: false });
    const first = hook.result.current.timing;
    expect(first.settledAt).toBeTypeOf("number");

    act(() => hook.result.current.markSubmitted());
    expect(hook.result.current.timing.settledAt).toBeUndefined();
    expect(hook.result.current.timing.submittedAt).toBeTypeOf("number");

    act(() => hook.result.current.clear());
    expect(hook.result.current.timing).toEqual({});
  });

  test("pending falling with no press in front of it marks nothing — an adopted run", () => {
    const hook = mount(true);
    hook.rerender({ pending: false });
    expect(hook.result.current.timing).toEqual({});
  });
});
