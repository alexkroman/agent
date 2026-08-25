// Copyright 2026 the AAI authors. MIT license.
/**
 * The microVM backend against a REAL microVM.
 *
 * The unit suite injects a `MicrosandboxSpawnContext`, so it can assert what
 * the backend ASKS for and nothing about what the VM does. Three properties are
 * only observable here, and one of them has already been a bug:
 *
 * - **The published port actually forwards.** `.network()` REPLACES the
 *   accumulated network config, so a `.port()` called before it is discarded —
 *   and the failure is silent: the harness logs `listening on 0.0.0.0:8080`
 *   inside the guest while every host dial gets ECONNREFUSED for the full dial
 *   budget, which reads as a guest that failed to boot. An injected context
 *   cannot see it, because the backend passes the right port either way.
 * - **The image boots the harness at all** — that the recipe put a runnable
 *   `node` and a `/opt/aai/harness.mjs` where the exec expects them.
 * - **The bearer gate is real**, on a real socket rather than a fake one.
 *
 * See `_microsandbox-test-utils.ts` for why this is a local tier and how
 * `AAI_REQUIRE_MICROSANDBOX=1` makes a skip a failure.
 */

import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { microsandboxGate, probeMicrosandbox } from "./_microsandbox-test-utils.ts";
import { resolveHarnessPath } from "./constants.ts";
import { spawnMicrosandboxWarm } from "./microsandbox-sandbox.ts";

// Top level, never inside the gated `describe` body — see probeMicrosandbox.
const gate = microsandboxGate(await probeMicrosandbox());
if (gate.skip) {
  // ANNOUNCED: a silent skip on the only tier that sees real VM behaviour is
  // indistinguishable from a passing run.
  console.warn(`microsandbox scenario tier SKIPPED — ${gate.reason}`);
}
const scenario = gate.skip ? describe.skip : describe;

scenario("spawnMicrosandboxWarm against a real microVM", () => {
  it("boots the guest image and serves its control channel over the published port", async () => {
    const t0 = performance.now();
    const warm = await spawnMicrosandboxWarm({
      harnessPath: resolveHarnessPath(),
      role: "studio",
      name: `scenario-warm-${process.pid}`,
    });
    try {
      // The regression assertion: an origin that resolves means the forward is
      // real, because `warmFromGuest` only returns after the dial succeeded.
      expect(warm.guestOrigin).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      expect(warm.alive()).toBe(true);
      expect(warm.token).toBeTruthy();
      console.info(`microVM spawn -> control channel: ${Math.round(performance.now() - t0)}ms`);
    } finally {
      await warm.cleanup();
    }
  });

  it("refuses an unauthenticated dial to the control channel", async () => {
    const warm = await spawnMicrosandboxWarm({
      harnessPath: resolveHarnessPath(),
      role: "studio",
      name: `scenario-auth-${process.pid}`,
    });
    try {
      // The published port is loopback-bound, so this is reachable from the
      // host — the bearer is the whole gate, exactly as on Modal's public tunnel.
      const rejected = await new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`${warm.guestOrigin}/ws`);
        ws.once("open", () => {
          ws.close();
          resolve(false);
        });
        ws.once("error", () => resolve(true));
        ws.once("unexpected-response", () => resolve(true));
      });
      expect(rejected).toBe(true);
    } finally {
      await warm.cleanup();
    }
  });

  it("stops the VM on cleanup, so a suite leaves nothing running", async () => {
    const warm = await spawnMicrosandboxWarm({
      harnessPath: resolveHarnessPath(),
      role: "studio",
      name: `scenario-stop-${process.pid}`,
    });
    await warm.cleanup();
    // Memoized and idempotent, like every other backend's cleanup.
    await expect(warm.cleanup()).resolves.toBeUndefined();
    expect(warm.alive()).toBe(false);
  });
});
