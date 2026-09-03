// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createEpoch } from "./epoch.ts";

describe("createEpoch", () => {
  test("a captured epoch is current until the next bump", () => {
    const epoch = createEpoch();
    const gen = epoch.current();
    expect(epoch.isCurrent(gen)).toBe(true);
    epoch.bump();
    expect(epoch.isCurrent(gen)).toBe(false);
    expect(epoch.isCurrent(epoch.current())).toBe(true);
  });

  test("every bump invalidates every earlier capture", () => {
    const epoch = createEpoch();
    const first = epoch.current();
    epoch.bump();
    const second = epoch.current();
    epoch.bump();
    expect(epoch.isCurrent(first)).toBe(false);
    expect(epoch.isCurrent(second)).toBe(false);
  });

  test("instances are independent", () => {
    const a = createEpoch();
    const b = createEpoch();
    const gen = a.current();
    b.bump();
    expect(a.isCurrent(gen)).toBe(true);
  });
});
