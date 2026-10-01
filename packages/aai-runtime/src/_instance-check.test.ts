// Copyright 2026 the AAI authors. MIT license.
/**
 * The detector for a second copy of this package in one process — the runtime
 * half of the gate whose build half is the guest's `harness/externals.test.ts`
 * and aai-cli's `worker-bundler.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import { claimRuntimeInstance } from "./_instance-check.ts";

describe("claimRuntimeInstance", () => {
  test("the first copy claims the process, and re-evaluating it is the same copy", () => {
    // `vi.resetModules()` and vitest's per-file isolation re-run ONE file: the same
    // URL, one install, nothing to report.
    const slot = {};
    const warn = vi.fn();
    expect(claimRuntimeInstance("file:///app/node_modules/x/dist/a.js", slot, warn)).toBe(true);
    expect(claimRuntimeInstance("file:///app/node_modules/x/dist/a.js", slot, warn)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a copy loaded from ANYWHERE ELSE warns, naming both", () => {
    // A nested install of another version, or a worker that inlined the runtime:
    // its state would be invisible to the first copy's, and nothing else says so.
    const slot = {};
    const warn = vi.fn();
    claimRuntimeInstance("file:///app/node_modules/x/dist/a.js", slot, warn);
    const nested = "file:///app/node_modules/aai-cli/node_modules/x/dist/a.js";
    expect(claimRuntimeInstance(nested, slot, warn)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("file:///app/node_modules/x/dist/a.js");
    expect(warn.mock.calls[0]?.[0]).toContain(nested);
  });
});
