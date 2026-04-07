// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, it } from "vitest";
import { createConnectionTracker } from "./connection-tracker.ts";

describe("createConnectionTracker", () => {
  it("allows connections under the limit", () => {
    const tracker = createConnectionTracker(3);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.count).toBe(3);
  });

  it("rejects connections at the limit", () => {
    const tracker = createConnectionTracker(2);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(false);
    expect(tracker.count).toBe(2);
  });

  it("allows new connections after release", () => {
    const tracker = createConnectionTracker(1);
    expect(tracker.tryAcquire()).toBe(true);
    expect(tracker.tryAcquire()).toBe(false);
    tracker.release();
    expect(tracker.count).toBe(0);
    expect(tracker.tryAcquire()).toBe(true);
  });

  it("never goes below zero", () => {
    const tracker = createConnectionTracker(5);
    tracker.release();
    expect(tracker.count).toBe(0);
  });
});
