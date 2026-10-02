// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest image's system-package declaration.
 *
 * The fingerprint that keeps a package change from reusing a published tag is
 * asserted next to the tag — `modal/harness-image.test.ts`; the Dockerfile's
 * `apt-get install` line is held to this list by `guest/image-dockerfile.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { GUEST_SYSTEM_PACKAGES, systemPackageList } from "./system-packages.ts";

describe("system packages", () => {
  test("lists the packages in sorted order, so reordering is not a change", () => {
    expect(systemPackageList(["sox", "ffmpeg"])).toBe("ffmpeg sox");
  });

  // The reason ffmpeg is in the image at all: `@alexkroman1/aai/ffmpeg` spawns
  // these two binaries by name, and the Debian package carries both.
  test("declares ffmpeg, which is what the SDK's ffmpeg helpers spawn", () => {
    expect(GUEST_SYSTEM_PACKAGES).toContain("ffmpeg");
  });
});
