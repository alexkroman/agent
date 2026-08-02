// Copyright 2026 the AAI authors. MIT license.
/**
 * Retirement is the difference between "the deploy landed" and "the deploy
 * hung up on everyone who was mid-call". These cover the two halves that make
 * it safe: no NEW session can reach a retired sandbox (its slot lets go of it
 * synchronously — see sandbox-slots.test.ts), and the OLD ones get to finish.
 *
 * Real timers with tiny durations rather than a faked clock: the drain
 * deadline is measured with `performance.now()` from `node:perf_hooks`, which
 * fake timers do not intercept, so a faked clock would silently never reach
 * the deadline and the test would hang instead of fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainingSandboxes, retireSandbox } from "./sandbox-retire.ts";

const POLL = 5;
const DEADLINE = 60;

/** A guest whose live-session count the test drives. */
function makeSandbox(sessions: () => number) {
  return {
    shutdown: vi.fn().mockResolvedValue(undefined),
    activeSessions: vi.fn(() => Promise.resolve(sessions())),
  };
}

describe("retireSandbox", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for live sessions to end, then shuts down", async () => {
    let live = 2;
    const sandbox = makeSandbox(() => live);
    const done = retireSandbox(sandbox, {
      slug: "talky",
      reason: "deploy",
      timeoutMs: DEADLINE * 20,
      pollMs: POLL,
    });

    // Calls still in flight — nothing is cut.
    await new Promise((r) => setTimeout(r, POLL * 3));
    expect(sandbox.shutdown).not.toHaveBeenCalled();
    expect(sandbox.activeSessions.mock.calls.length).toBeGreaterThan(1);

    live = 0;
    await done;
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("shuts down immediately when nothing is connected", async () => {
    const sandbox = makeSandbox(() => 0);
    await retireSandbox(sandbox, { slug: "quiet", reason: "deploy", pollMs: POLL });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    // The first probe happens before any sleep — a deploy on a quiet agent
    // reclaims the old sandbox with no drain delay at all.
    expect(sandbox.activeSessions).toHaveBeenCalledOnce();
  });

  it("cuts stragglers once the drain deadline passes", async () => {
    // A call that never ends must not pin a superseded bundle forever.
    const sandbox = makeSandbox(() => 1);
    await retireSandbox(sandbox, {
      slug: "endless",
      reason: "deploy",
      timeoutMs: DEADLINE,
      pollMs: POLL,
    });

    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith(
      "Retired sandbox still had sessions at the drain deadline; closing",
      expect.objectContaining({ slug: "endless", remaining: 1 }),
    );
  });

  it("stops draining a guest that died mid-drain", async () => {
    // An unreachable guest answers 0 (see Sandbox.activeSessions), so the
    // loop must not spend the whole deadline polling a corpse.
    const sandbox = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      activeSessions: vi.fn().mockRejectedValue(new Error("guest gone")),
    };
    await retireSandbox(sandbox, {
      slug: "dead",
      reason: "deploy",
      timeoutMs: DEADLINE * 100,
      pollMs: POLL,
    });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(sandbox.activeSessions).toHaveBeenCalledOnce();
  });

  it("shuts the sandbox down even when the drain loop throws", async () => {
    const sandbox = {
      shutdown: vi.fn().mockResolvedValue(undefined),
      activeSessions: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    await retireSandbox(sandbox, { slug: "broken", reason: "deploy", pollMs: POLL });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("tracks draining sandboxes so process teardown can reach them", async () => {
    let live = 1;
    const sandbox = makeSandbox(() => live);
    const done = retireSandbox(sandbox, {
      slug: "tracked",
      reason: "deploy",
      timeoutMs: DEADLINE * 20,
      pollMs: POLL,
    });

    // Detached from its slot but still billed — teardown must see it.
    await new Promise((r) => setTimeout(r, POLL));
    expect(drainingSandboxes()).toContain(sandbox);

    live = 0;
    await done;
    expect(drainingSandboxes()).not.toContain(sandbox);
  });

  it("terminates without draining when the window is disabled", async () => {
    const sandbox = makeSandbox(() => 5);
    await retireSandbox(sandbox, { slug: "instant", reason: "deploy", timeoutMs: 0 });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
    expect(sandbox.activeSessions).not.toHaveBeenCalled();
  });

  it("terminates a stand-in with no session probe", async () => {
    const sandbox = { shutdown: vi.fn().mockResolvedValue(undefined) };
    await retireSandbox(sandbox, { slug: "probeless", reason: "deploy" });
    expect(sandbox.shutdown).toHaveBeenCalledOnce();
  });

  it("never throws when shutdown fails", async () => {
    const sandbox = {
      shutdown: vi.fn().mockRejectedValue(new Error("modal down")),
      activeSessions: vi.fn().mockResolvedValue(0),
    };
    await expect(
      retireSandbox(sandbox, { slug: "unkillable", reason: "deploy", pollMs: POLL }),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      "Failed to shut down retired sandbox",
      expect.objectContaining({ slug: "unkillable" }),
    );
  });
});
