// Copyright 2026 the AAI authors. MIT license.
/**
 * The host surface a bundle hands the runtime-less guest harness.
 *
 * The harness reads these fields by NAME off a bundle built from any SDK
 * version, so the shape is the contract: a field removed or renamed here is a
 * harness that cannot boot a bundle, and has to move `GUEST_HOST_VERSION` with it.
 */

import { describe, expect, test } from "vitest";
import { GUEST_HOST, GUEST_HOST_VERSION } from "./guest-host.ts";
import { createServerForRuntime } from "./server/index.ts";

describe("GUEST_HOST", () => {
  test("names exactly the fields the harness reads, at the declared version", () => {
    expect(GUEST_HOST.version).toBe(GUEST_HOST_VERSION);
    expect(Object.keys(GUEST_HOST).sort()).toEqual(
      [
        "SESSION_SECRET_ENV",
        "agentServerEnv",
        "createRuntimeServer",
        "createSessionAuth",
        "handleWorkflowRequest",
        "platformSessionSecret",
        "publishWorkflowWebhookUrl",
        "startTracingDetached",
        "verifySessionToken",
        "version",
      ].sort(),
    );
  });

  test("is THIS copy's runtime, and cannot be edited by whoever holds it", () => {
    // The point of the surface: the server the harness builds through it is the
    // same module instance the bundle's sessions run on.
    expect(GUEST_HOST.createRuntimeServer).toBe(createServerForRuntime);
    expect(Object.isFrozen(GUEST_HOST)).toBe(true);
  });
});
