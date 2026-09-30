// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { CLIENT_TOUCH_INTERVAL_MS, createClientTouchThrottle } from "./client-touch.ts";

function throttle() {
  let now = 1_000_000;
  const touches = createClientTouchThrottle(() => now);
  return {
    touches,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createClientTouchThrottle", () => {
  test("an unbound session never touches, on append or on settle", () => {
    const { touches } = throttle();
    expect(touches.onAppend("free")).toBe(false);
    expect(touches.onSettle("free")).toBe(false);
  });

  test("the first append after a bind touches; the next inside the window is owed", () => {
    const { touches, advance } = throttle();
    touches.bind("s");
    expect(touches.onAppend("s")).toBe(true);
    advance(CLIENT_TOUCH_INTERVAL_MS - 1);
    expect(touches.onAppend("s")).toBe(false);
    // The stop pays it, once.
    expect(touches.onSettle("s")).toBe(true);
    expect(touches.onSettle("s")).toBe(false);
  });

  test("an append a full window after the last touch touches again", () => {
    const { touches, advance } = throttle();
    touches.bind("s");
    touches.onAppend("s");
    advance(CLIENT_TOUCH_INTERVAL_MS);
    expect(touches.onAppend("s")).toBe(true);
    expect(touches.onSettle("s")).toBe(false);
  });

  test("a re-bind keeps the throttle; forget drops it until the next bind", () => {
    const { touches } = throttle();
    touches.bind("s");
    touches.onAppend("s");
    touches.bind("s");
    expect(touches.onAppend("s")).toBe(false);
    touches.forget("s");
    expect(touches.onSettle("s")).toBe(false);
    touches.bind("s");
    expect(touches.onAppend("s")).toBe(true);
  });
});
