// Copyright 2026 the AAI authors. MIT license.
/**
 * `workletModuleUrl` — a processor's source as a URL `audioWorklet.addModule`
 * can load.
 *
 * Node's `URL.createObjectURL` is the same API a browser has, and
 * `resolveObjectURL` reads the blob back, so the round trip is asserted on
 * the real object rather than on a stub of it.
 */

import { resolveObjectURL } from "node:buffer";
import { describe, expect, test } from "vitest";
import { workletModuleUrl } from "./_module-url.ts";

describe("workletModuleUrl", () => {
  test("is a blob URL holding exactly the source, typed as JavaScript", async () => {
    const source = "registerProcessor('noop', class extends AudioWorkletProcessor {});";
    const url = workletModuleUrl(source);
    try {
      expect(url.startsWith("blob:")).toBe(true);
      const blob = resolveObjectURL(url);
      expect(blob?.type).toBe("application/javascript");
      expect(await blob?.text()).toBe(source);
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  test("each call mints its own URL", () => {
    const first = workletModuleUrl("a");
    const second = workletModuleUrl("a");
    try {
      expect(first).not.toBe(second);
    } finally {
      URL.revokeObjectURL(first);
      URL.revokeObjectURL(second);
    }
  });
});
