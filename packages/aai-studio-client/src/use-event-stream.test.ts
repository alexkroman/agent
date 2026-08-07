// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StreamHandlers } from "./use-event-stream.ts";
import { useEventStream } from "./use-event-stream.ts";

/**
 * Drive the hook with a scripted stream: each attempt runs `script` with the
 * handlers, and the times at which attempts START are what we assert on.
 */
function drive(script: (h: StreamHandlers) => void) {
  const attempts: number[] = [];
  const subscribe = (handlers: StreamHandlers) => {
    attempts.push(Date.now());
    script(handlers);
    return () => undefined;
  };
  const view = renderHook(() => useEventStream(subscribe, async () => undefined));
  return { attempts, ...view };
}

/** Gaps between successive attempts. */
function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] as number));
}

describe("useEventStream backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a stream that never opens backs off exponentially", async () => {
    const { attempts, unmount } = drive((h) => {
      h.onDown("transport");
    });
    await vi.advanceTimersByTimeAsync(30_000);
    unmount();
    expect(gaps(attempts).slice(0, 3)).toEqual([3000, 6000, 12_000]);
  });

  // The bug this guards: `onOpen` fired when the server ACCEPTED the stream,
  // which reset the counter — so a server that answers 200 and then ends the
  // body immediately (a crash-looping container, a Modal instance being
  // replaced, a proxy that upgrades and drops) reset the backoff on every
  // attempt and it never grew. Measured against a real server in that state:
  // a flat attempt every 3.0s indefinitely, versus 3/6/12s when the same
  // server refused outright. Two subscriptions per tab, so ~40 requests a
  // minute aimed at an already-unhealthy server.
  test("a stream ACCEPTED then dropped immediately still backs off", async () => {
    const { attempts, unmount } = drive((h) => {
      h.onOpen();
      h.onDown("transport");
    });
    await vi.advanceTimersByTimeAsync(30_000);
    unmount();
    expect(gaps(attempts).slice(0, 3)).toEqual([3000, 6000, 12_000]);
  });

  test("a stream that SERVED before dropping reconnects promptly", async () => {
    // The reset the hook exists to give: a long-lived subscription that drops
    // once must come back at the floor, not carry a stale failure count.
    const { attempts, unmount } = drive((h) => {
      h.onOpen();
      setTimeout(() => h.onDown("transport"), 20_000);
    });
    await vi.advanceTimersByTimeAsync(90_000);
    unmount();
    // Each cycle: 20s serving + the 3s floor.
    expect(gaps(attempts).slice(0, 2)).toEqual([23_000, 23_000]);
  });

  test("an auth failure refreshes the bearer rather than retrying it", async () => {
    const onAuthFailure = vi.fn(async () => undefined);
    const subscribe = (handlers: StreamHandlers) => {
      handlers.onDown("auth");
      return () => undefined;
    };
    const { unmount } = renderHook(() => useEventStream(subscribe, onAuthFailure));
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    expect(onAuthFailure).toHaveBeenCalled();
  });
});
