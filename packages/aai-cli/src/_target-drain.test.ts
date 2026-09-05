// Copyright 2026 the AAI authors. MIT license.
/**
 * The shared drain, asserted where it LIVES rather than in one host's suite.
 *
 * Both long-lived entries interpolate {@link TARGET_DRAIN_SOURCE}, so the
 * property worth pinning is that they really carry the same text: this used to
 * be Modal's alone, and the Deno target went without a shutdown handler for as
 * long as that was true.
 */

import { describe, expect, test } from "vitest";
import { DENO_ENTRY_SOURCE } from "./_deno-target.ts";
import { MODAL_ENTRY_SOURCE } from "./_modal-target.ts";
import { TARGET_DRAIN_SOURCE } from "./_target-drain.ts";

/** Everything from the signal list on — the drain and nothing before it. */
function drainOf(source: string): string {
  return source.slice(source.indexOf('["SIGINT", "SIGTERM"]'));
}

describe("TARGET_DRAIN_SOURCE", () => {
  test("both long-lived entries carry the IDENTICAL drain", () => {
    // One constant interpolated into both, so the next long-lived target does
    // not get to rediscover it — and so a fix to one is a fix to both.
    expect(drainOf(MODAL_ENTRY_SOURCE)).toBe(drainOf(DENO_ENTRY_SOURCE));
    expect(drainOf(MODAL_ENTRY_SOURCE)).toBe(drainOf(TARGET_DRAIN_SOURCE));
  });

  test("closes the SERVER rather than exiting on the signal", () => {
    // The whole point: a process that exits on SIGTERM drops its sockets, and
    // for a voice agent those are live calls. `close()` ends the sessions.
    expect(TARGET_DRAIN_SOURCE).toContain("server.close()");
    expect(TARGET_DRAIN_SOURCE).toMatch(/\["SIGINT", "SIGTERM"\]/);
    // Non-zero on a failed close, so a supervisor waiting on this process can
    // tell a clean drain from one that gave up.
    expect(TARGET_DRAIN_SOURCE).toContain("process.exit(1)");
  });

  test("the listener is SYNCHRONOUS", () => {
    // For the reason `executeStart` documents: an async listener hands its
    // promise to `process`, which discards it, so a failed shutdown would
    // surface as an unhandled rejection instead of a non-zero exit.
    expect(TARGET_DRAIN_SOURCE).not.toMatch(/process\.once\([^)]*async/);
  });

  test("registration cannot break a boot on a host with no signals", () => {
    // Deno routes `process.on("SIGTERM")` through `Deno.addSignalListener`,
    // which THROWS where the platform has no signal to deliver — and a throw
    // at the top level of the entry is a deployment that does not boot at all.
    // A host that cannot signal us is a host we have nothing to drain on.
    expect(TARGET_DRAIN_SOURCE).toMatch(/try \{/);
    expect(TARGET_DRAIN_SOURCE).toMatch(/\} catch \{/);
  });
});
