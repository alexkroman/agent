// Copyright 2025 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _internals } from "./sandbox.ts";

// ── _internals.IDLE_MS proxy ─────────────────────────────────────────────

describe("_internals.IDLE_MS", () => {
  let saved: number;

  beforeEach(() => {
    saved = _internals.IDLE_MS;
  });

  afterEach(() => {
    _internals.IDLE_MS = saved;
  });

  it("proxies get/set to _slotInternals", () => {
    _internals.IDLE_MS = 42;
    expect(_internals.IDLE_MS).toBe(42);
  });
});
