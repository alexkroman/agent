// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the guest image's system-package layer.
 *
 * The layer's ORDER relative to the toolchain, and the fingerprint that keeps a
 * package change from reusing a published tag, are asserted next to the image
 * they belong to — `modal-harness-image.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { GUEST_SYSTEM_PACKAGES, systemPackagesImage } from "./modal-system-packages.ts";
import { fakeModalImage as fakeImage } from "./test-utils.ts";

describe("systemPackagesImage", () => {
  test("installs the declared packages in one layer, and keeps no apt index", () => {
    const image = fakeImage();
    systemPackagesImage(image, ["ffmpeg"]);
    expect(image.commands).toHaveLength(1);
    const line = image.commands[0]?.[0] ?? "";
    expect(line).toContain("apt-get install -y --no-install-recommends ffmpeg");
    // The recommends of ffmpeg alone pull an X stack the guest has no display
    // for, and a cached index is bytes on every sandbox's cold-start path.
    expect(line).toContain("--no-install-recommends");
    expect(line).toContain("rm -rf /var/lib/apt/lists/*");
  });

  // `apt-get install` with no packages FAILS, and it would fail inside an image
  // build whose error reaches an operator as a failed spawn.
  test("returns the base image untouched when nothing is declared", () => {
    const image = fakeImage();
    expect(systemPackagesImage(image, [])).toBe(image);
    expect(image.commands).toEqual([]);
  });

  test("names the packages in the same sorted order the fingerprint hashes", () => {
    const image = fakeImage();
    systemPackagesImage(image, ["sox", "ffmpeg"]);
    const line = image.commands[0]?.[0] ?? "";
    expect(line).toContain("ffmpeg sox");
  });

  // The reason ffmpeg is in the image at all: `@alexkroman1/aai/ffmpeg` spawns
  // these two binaries by name, and the Debian package carries both.
  test("declares ffmpeg, which is what the SDK's ffmpeg helpers spawn", () => {
    expect(GUEST_SYSTEM_PACKAGES).toContain("ffmpeg");
  });
});
