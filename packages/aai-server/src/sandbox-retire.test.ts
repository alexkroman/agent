// Copyright 2026 the AAI authors. MIT license.
/**
 * Retirement is the difference between "the deploy landed" and "the deploy
 * hung up on everyone who was mid-call". The GUEST owns the drain — one
 * deadline-carrying request and the host forgets (see
 * aai-guest/harness-agent-mode.test.ts for the guest half). The returned
 * promise resolves on DELIVERY, never rejects, and is awaited only by
 * process shutdown; request-path callers void it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { retireSandbox } from "./sandbox-retire.ts";

describe("retireSandbox", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("hands a reachable guest its drain budget and never terminates it", async () => {
    const sandbox = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockResolvedValue(undefined),
    };
    await retireSandbox(sandbox, { slug: "s", reason: "superseded", timeoutMs: 60_000 });
    expect(sandbox.drain).toHaveBeenCalledExactlyOnceWith(60_000);
    // The guest exits itself when empty or at the deadline; the host holds
    // no drain state and must not shut the guest down under its callers.
    expect(sandbox.shutdown).not.toHaveBeenCalled();
  });

  it("terminates an unreachable guest immediately (nothing to drain)", async () => {
    const sandbox = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockRejectedValue(new Error("guest gone")),
    };
    await retireSandbox(sandbox, { slug: "s", reason: "superseded" });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("terminates immediately when the drain window is zero", async () => {
    const sandbox = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      drain: vi.fn().mockResolvedValue(undefined),
    };
    await retireSandbox(sandbox, { slug: "s", reason: "superseded", timeoutMs: 0 });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(sandbox.drain).not.toHaveBeenCalled();
  });

  it("terminates a stand-in with no drain surface", async () => {
    const sandbox = { shutdown: vi.fn().mockResolvedValue(undefined) };
    await retireSandbox(sandbox, { slug: "s", reason: "superseded" });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("never rejects, even when everything rejects", async () => {
    const sandbox = {
      shutdown: vi.fn().mockRejectedValue(new Error("already gone")),
      drain: vi.fn().mockRejectedValue(new Error("guest gone")),
    };
    await expect(
      retireSandbox(sandbox, { slug: "s", reason: "superseded" }),
    ).resolves.toBeUndefined();
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });
});
