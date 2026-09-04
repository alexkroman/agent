// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlash } from "./use-flash.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFlash", () => {
  it("shows nothing until something is flashed", () => {
    const { result } = renderHook(() => useFlash<string>());

    expect(result.current.value).toBeNull();
  });

  it("clears itself after the default window", () => {
    const { result } = renderHook(() => useFlash<string>());

    act(() => result.current.flash("Saved"));
    expect(result.current.value).toBe("Saved");

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(result.current.value, "cleared before its window elapsed").toBe("Saved");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.value).toBeNull();
  });

  it("honours a caller's own duration", () => {
    const { result } = renderHook(() => useFlash<string>(50));

    act(() => result.current.flash("Sent"));
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(result.current.value).toBeNull();
  });

  /*
   * The whole reason this is a primitive rather than a `setTimeout` at the call
   * site: a naive version arms a SECOND timer, so the first click's timeout
   * fires mid-way through the second flash and cuts its window short. Flashing
   * at t=1000 with a 1500ms window must survive until t=2500, not t=1500.
   */
  it("re-arms rather than stacking, so a second flash gets its full window", () => {
    const { result } = renderHook(() => useFlash<string>());

    act(() => result.current.flash("first"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => result.current.flash("second"));

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.value, "the first flash's timer cut the second one short").toBe("second");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.value).toBeNull();
  });

  it("fires no timer after unmount", () => {
    const { result, unmount } = renderHook(() => useFlash<string>());

    act(() => result.current.flash("Saved"));
    unmount();

    // A pending timer would `setState` on a torn-down component; with the
    // teardown clear in place there is nothing left to run at all.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("carries a record, not only a label", () => {
    const { result } = renderHook(() => useFlash<{ id: string; ok: boolean }>());

    act(() => result.current.flash({ id: "a", ok: false }));

    expect(result.current.value).toEqual({ id: "a", ok: false });
  });
});
