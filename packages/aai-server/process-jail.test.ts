// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { buildSeccompPolicy } from "./seccomp-policy.ts";

describe("buildSeccompPolicy", () => {
  test("generates ALLOW block with syscalls", () => {
    const policy = buildSeccompPolicy();
    expect(policy).toContain("ALLOW");
    expect(policy).toContain("read");
    expect(policy).toContain("write");
    expect(policy).toContain("mmap");
  });

  test("sets default action to KILL", () => {
    const policy = buildSeccompPolicy();
    expect(policy).toContain("DEFAULT KILL");
  });
});
