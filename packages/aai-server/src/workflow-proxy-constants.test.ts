// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";

/** A fresh evaluation of the module, so its import-time env reads see the stubs. */
async function load() {
  vi.resetModules();
  return await import("./workflow-proxy-constants.ts");
}

describe("workflow proxy constants", () => {
  test("the proxy header is the literal the guest verifies", async () => {
    // Duplicated across the boundary by design (aai-guest's workflow-gate.ts);
    // a drift 401s every workflow request.
    expect((await load()).GUEST_PROXY_TOKEN_HEADER).toBe("x-aai-guest-token");
  });

  test("defaults: 30s head deadline, 120s transfer deadline", async () => {
    vi.stubEnv("WORKFLOW_PROXY_TIMEOUT_MS", undefined);
    vi.stubEnv("WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS", undefined);
    const mod = await load();
    expect(mod.WORKFLOW_PROXY_TIMEOUT_MS).toBe(30_000);
    expect(mod.WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS).toBe(120_000);
    expect(mod.WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS).toBeGreaterThan(mod.WORKFLOW_PROXY_TIMEOUT_MS);
  });

  test("each honours its own override, and ignores a malformed one", async () => {
    vi.stubEnv("WORKFLOW_PROXY_TIMEOUT_MS", "5000");
    vi.stubEnv("WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS", "two minutes");
    const mod = await load();
    expect(mod.WORKFLOW_PROXY_TIMEOUT_MS).toBe(5000);
    expect(mod.WORKFLOW_PROXY_TRANSFER_TIMEOUT_MS).toBe(120_000);
  });
});
