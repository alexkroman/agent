// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { recordingSlot } from "./_testing-slot.ts";

type Fn = (a: string, b: number) => string;

describe("recordingSlot", () => {
  test("publishes a recorder that logs each call, then answers it", () => {
    const publish = vi.fn<(fn: Fn | undefined) => void>();
    const slot = recordingSlot(
      publish,
      (a: string, b: number) => ({ a, b }),
      (call) => `${call.a}:${call.b}`,
    );
    const published = publish.mock.calls[0]?.[0];
    expect(published?.("x", 1)).toBe("x:1");
    expect(published?.("y", 2)).toBe("y:2");
    expect(slot.calls).toEqual([
      { a: "x", b: 1 },
      { a: "y", b: 2 },
    ]);
  });

  test("restore unpublishes", () => {
    const publish = vi.fn<(fn: Fn | undefined) => void>();
    recordingSlot(publish, (a: string) => a, String).restore();
    expect(publish).toHaveBeenLastCalledWith(undefined);
  });

  test("wrap adapts what is published without moving the recording out", () => {
    const publish = vi.fn<(fn: Fn | undefined) => void>();
    const slot = recordingSlot(
      publish,
      (a: string, _b: number) => a,
      (call) => call,
      (fn) => (a, b) => fn(a.toUpperCase(), b),
    );
    expect(publish.mock.calls[0]?.[0]?.("x", 1)).toBe("X");
    expect(slot.calls).toEqual(["X"]);
  });
});
