// Copyright 2026 the AAI authors. MIT license.
/**
 * The `Cancel` → `Cancelled` suppression window, on its own: it counts
 * outstanding cancels rather than flagging one, and its acknowledgement
 * deadline fires only for a cancel nothing answered. Virtual time.
 */

import { TTS_CANCEL_ACK_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCancelBarrier } from "./assemblyai-cancel.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCancelBarrier", () => {
  test("open until armed, shut until acknowledged", () => {
    const barrier = createCancelBarrier(vi.fn());
    expect(barrier.abandoned()).toBe(false);
    barrier.arm();
    expect(barrier.abandoned()).toBe(true);
    barrier.onCancelled();
    expect(barrier.abandoned()).toBe(false);
  });

  test("two cancels need two acknowledgements; a stray one cannot go negative", () => {
    const barrier = createCancelBarrier(vi.fn());
    barrier.arm();
    barrier.arm();
    barrier.onCancelled();
    expect(barrier.abandoned()).toBe(true);
    barrier.onCancelled();
    barrier.onCancelled();
    expect(barrier.abandoned()).toBe(false);
    barrier.arm();
    expect(barrier.abandoned()).toBe(true);
  });

  test("an unanswered cancel fires the deadline once", async () => {
    const onAckTimeout = vi.fn();
    const barrier = createCancelBarrier(onAckTimeout);
    barrier.arm();
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS - 1);
    expect(onAckTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAckTimeout).toHaveBeenCalledTimes(1);
  });

  test("an answered cancel, or a reset, disarms the deadline", async () => {
    const onAckTimeout = vi.fn();
    const answered = createCancelBarrier(onAckTimeout);
    answered.arm();
    answered.onCancelled();
    const reset = createCancelBarrier(onAckTimeout);
    reset.arm();
    reset.arm();
    reset.reset();
    expect(reset.abandoned()).toBe(false);
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS * 2);
    expect(onAckTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a second cancel re-arms the deadline from its own send", async () => {
    const onAckTimeout = vi.fn();
    const barrier = createCancelBarrier(onAckTimeout);
    barrier.arm();
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS - 1);
    barrier.arm();
    await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS - 1);
    expect(onAckTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onAckTimeout).toHaveBeenCalledTimes(1);
  });
});
