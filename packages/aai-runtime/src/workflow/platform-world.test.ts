// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the composition.
 *
 * One property here fails SILENTLY, which is why it gets its own spec: if the
 * composed world inherits the base world's `start`, graphile-worker subscribes
 * anyway and the whole change is undone with no symptom but connection pressure —
 * nothing errors, no run misbehaves, and the only evidence is a number on a
 * Postgres instance. A spread is the natural way to write this and the wrong one.
 */

import { describe, expect, test, vi } from "vitest";
import {
  describePlatformQueueGap,
  platformGuestOptions,
  resolvePlatformQueue,
} from "./platform-world.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

describe("resolvePlatformQueue", () => {
  test("reads the pair the platform bakes into a deployed guest", () => {
    expect(resolvePlatformQueue({ AAI_PLATFORM_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN })).toEqual({
      base: BASE,
      token: TOKEN,
    });
  });

  test("dials the DIAL base, never the public one, which is a different claim", () => {
    // The regression, and the whole reason the two keys split. The public base
    // is what a third party is handed, so it must resolve from the internet;
    // this one is dialled from inside the sandbox. Under a microVM backend the
    // guest's own port IS the platform's port, so preferring the public value
    // sent every platform call to the caller itself — `POST /<slug>/workflow-
    // storage 404`, answered by the guest's own 404 handler.
    expect(
      resolvePlatformQueue({
        AAI_PLATFORM_BASE_URL: "http://host.microsandbox.internal:8080/demo",
        AAI_PUBLIC_BASE_URL: "http://127.0.0.1:8080/demo",
        AAI_GUEST_TOKEN: TOKEN,
      })?.base,
    ).toBe("http://host.microsandbox.internal:8080/demo");
  });

  test("the public base alone is not a dial base", () => {
    expect(
      resolvePlatformQueue({ AAI_PUBLIC_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN }),
    ).toBeUndefined();
  });

  test.each([
    ["neither, which is `aai dev` and every self-hosted server", {}],
    ["only the base", { AAI_PLATFORM_BASE_URL: BASE }],
    ["only the token", { AAI_GUEST_TOKEN: TOKEN }],
    ["blank values", { AAI_PLATFORM_BASE_URL: "  ", AAI_GUEST_TOKEN: "  " }],
  ])("declines %s", (_label, env) => {
    expect(resolvePlatformQueue(env)).toBeUndefined();
  });
});

describe("platformGuestOptions", () => {
  test("reads the PROCESS env, which is where the platform puts the pair", () => {
    vi.stubEnv("AAI_PLATFORM_BASE_URL", BASE);
    vi.stubEnv("AAI_GUEST_TOKEN", TOKEN);
    expect(platformGuestOptions()).toEqual({ base: BASE, token: TOKEN });
  });

  test("declines when the process env has neither, which is `aai dev`", () => {
    vi.stubEnv("AAI_PLATFORM_BASE_URL", undefined);
    vi.stubEnv("AAI_GUEST_TOKEN", undefined);
    expect(platformGuestOptions()).toBeUndefined();
  });
});

describe("describePlatformQueueGap", () => {
  // A HALF-configured environment means the platform spawns guests differently
  // than this code expects. Falling back silently to the in-guest queue would hide
  // that behind a connection bill nobody reads, so the caller reports it.
  test.each([
    [{ AAI_PLATFORM_BASE_URL: BASE }, /AAI_PLATFORM_BASE_URL is set but AAI_GUEST_TOKEN/],
    [{ AAI_GUEST_TOKEN: TOKEN }, /AAI_GUEST_TOKEN is set but AAI_PLATFORM_BASE_URL/],
  ])("names which half is missing for %o", (env, expected) => {
    expect(describePlatformQueueGap(env)).toMatch(expected);
  });

  test.each([
    ["both present", { AAI_PLATFORM_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN }],
    ["neither present", {}],
  ])("says nothing when the environment is coherent (%s)", (_label, env) => {
    expect(describePlatformQueueGap(env)).toBeUndefined();
  });
});
