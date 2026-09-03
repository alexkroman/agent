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
} from "./workflow-platform-world.ts";

const BASE = "https://api.test/my-agent";
const TOKEN = "sandbox-bearer";

describe("resolvePlatformQueue", () => {
  test("reads the pair the platform bakes into a deployed guest", () => {
    expect(resolvePlatformQueue({ AAI_PLATFORM_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN })).toEqual({
      base: BASE,
      token: TOKEN,
    });
  });

  test("prefers the DIAL base over the public one, which is a different claim", () => {
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

  test("falls back to the public base, for a guest booted before the key existed", () => {
    // Not politeness: an agent sandbox runs the harness image PINNED at deploy
    // time, so a guest older than this key receives only the public one and
    // would otherwise lose its platform world entirely — durable runs silently
    // onto the DevKit's local world, session state silently onto memory. On
    // every backend but microsandbox the two values are identical, which is
    // what makes the fallback restore that guest's exact prior behaviour.
    expect(resolvePlatformQueue({ AAI_PUBLIC_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN })).toEqual({
      base: BASE,
      token: TOKEN,
    });
  });

  test.each([
    ["neither, which is `aai dev` and every self-hosted server", {}],
    ["only the base", { AAI_PLATFORM_BASE_URL: BASE }],
    ["only the token", { AAI_GUEST_TOKEN: TOKEN }],
    ["blank values", { AAI_PLATFORM_BASE_URL: "  ", AAI_GUEST_TOKEN: "  " }],
    [
      "a blank dial base with a blank public one behind it",
      { AAI_PLATFORM_BASE_URL: " ", AAI_PUBLIC_BASE_URL: " ", AAI_GUEST_TOKEN: TOKEN },
    ],
  ])("declines %s", (_label, env) => {
    expect(resolvePlatformQueue(env)).toBeUndefined();
  });
});

describe("platformGuestOptions", () => {
  test("reads the PROCESS env, which is where the platform puts the pair", () => {
    vi.stubEnv("AAI_PUBLIC_BASE_URL", BASE);
    vi.stubEnv("AAI_GUEST_TOKEN", TOKEN);
    expect(platformGuestOptions()).toEqual({ base: BASE, token: TOKEN });
  });

  test("declines when the process env has neither, which is `aai dev`", () => {
    vi.stubEnv("AAI_PUBLIC_BASE_URL", undefined);
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

  test("reports the same gap through the fallback, so an older guest is not silent", () => {
    // The gap is about the PAIR, and the fallback is part of what resolves the
    // base — so a pinned older guest missing only its token has to be named
    // too, or the one deployment shape that cannot be redeployed out of the
    // problem is the one that reports nothing.
    expect(describePlatformQueueGap({ AAI_PUBLIC_BASE_URL: BASE })).toMatch(
      /AAI_PLATFORM_BASE_URL is set but AAI_GUEST_TOKEN/,
    );
  });

  test.each([
    ["both present", { AAI_PLATFORM_BASE_URL: BASE, AAI_GUEST_TOKEN: TOKEN }],
    ["neither present", {}],
  ])("says nothing when the environment is coherent (%s)", (_label, env) => {
    expect(describePlatformQueueGap(env)).toBeUndefined();
  });
});
