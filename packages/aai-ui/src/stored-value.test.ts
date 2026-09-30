// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * A remembered string: read back after a "reload", `""` forgets it, every
 * holder of the key is told of a write (including another tab's), and a
 * browser that refuses storage still works for the tab.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStoredValue, useStoredValue } from "./stored-value.ts";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createStoredValue", () => {
  test("answers the initial until set, remembers across holders, and forgets on empty", () => {
    const a = createStoredValue("t:phone", { initial: "none" });
    expect(a.get()).toBe("none");
    a.set("+15555550123");
    expect(createStoredValue("t:phone").get()).toBe("+15555550123");
    expect(localStorage.getItem("t:phone")).toBe("+15555550123");
    a.set("");
    expect(localStorage.getItem("t:phone")).toBeNull();
    expect(a.get()).toBe("none");
  });

  test('"session" storage is its own store', () => {
    createStoredValue("t:k", { storage: "session" }).set("tab");
    expect(sessionStorage.getItem("t:k")).toBe("tab");
    expect(localStorage.getItem("t:k")).toBeNull();
  });

  test("a storage that throws keeps the value in memory for the tab", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const v = createStoredValue("t:private");
    v.set("kept");
    expect(v.get()).toBe("kept");
  });
});

describe("useStoredValue", () => {
  test("re-renders on a write from another holder and from another tab", () => {
    const shared = createStoredValue("t:units", { initial: "metric" });
    const hook = renderHook(() => useStoredValue(shared));
    const byKey = renderHook(() => useStoredValue("t:units", "metric"));
    expect(hook.result.current[0]).toBe("metric");
    act(() => byKey.result.current[1]("imperial"));
    expect(hook.result.current[0]).toBe("imperial");

    localStorage.setItem("t:units", "kelvin");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "t:units" }));
    });
    expect(hook.result.current[0]).toBe("kelvin");
    expect(byKey.result.current[0]).toBe("kelvin");
  });
});
