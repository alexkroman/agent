// Copyright 2026 the AAI authors. MIT license.

import { getMaxListeners } from "node:events";
import { describe, expect, test } from "vitest";
import { createSessionSignal } from "./pipeline-session-signal.ts";

describe("createSessionSignal", () => {
  test("is an ordinary controller: aborting it aborts the signal", () => {
    const controller = createSessionSignal();
    expect(controller.signal.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  test("opts the SIGNAL into the max-listeners alarm, above the default", () => {
    // The whole reason this function exists. An `AbortSignal` is an
    // EventTarget, and Node's leak warning covers `EventEmitter` only unless
    // the target is opted in — so without this call a session that leaks one
    // `abort` listener per turn reports nothing, for the length of the call.
    expect(getMaxListeners(createSessionSignal().signal)).toBe(50);
    // A signal nobody opted in reads 0 — not 10, which is the EMITTER default.
    // That zero IS the silence this function exists to end.
    expect(getMaxListeners(new AbortController().signal)).toBe(0);
  });

  test("each call is its own controller", () => {
    const first = createSessionSignal();
    const second = createSessionSignal();
    first.abort();
    expect(second.signal.aborted).toBe(false);
  });
});
