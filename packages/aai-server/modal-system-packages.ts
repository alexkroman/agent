// Copyright 2026 the AAI authors. MIT license.
/**
 * The system packages a guest sandbox gets on top of its base image.
 *
 * Its own module because it is its own image LAYER, cached on its own commands
 * and invalidated by nothing the toolchain does (see `modal-harness-image.ts`
 * for how the layers stack), and because both things it exports have to agree
 * exactly: the `apt-get install` line and the image FINGERPRINT.
 */

import type { Image } from "modal";

/**
 * System packages the guest image installs on top of the base image.
 *
 * **`ffmpeg`**, so a workflow can transcode, cut and probe media in a step —
 * see `@alexkroman1/aai/ffmpeg`, which spawns these binaries and nothing else.
 * The Debian package carries `ffprobe` too, which is half of why it is the
 * delivery mechanism: an npm binary package (`ffmpeg-static`) is GPL-3.0, ships
 * one binary per install, and would land in the dependency tree of a PUBLISHED
 * package, where the artifact-size budget counts it against every consumer.
 * Here it is a layer in an image the platform builds, so it costs a tenant
 * nothing to not use it.
 *
 * Installed by their own layer, FIRST, because the two halves of this image
 * change at completely different rates: the toolchain layer is invalidated by
 * every SDK release, and apt would be reinstalled with it if it sat on top.
 */
export const GUEST_SYSTEM_PACKAGES = ["ffmpeg"] as const;

/**
 * The system-package install as its own image LAYER.
 *
 * `--no-install-recommends` because the recommends of `ffmpeg` alone pull an X
 * stack the guest has no display for, and the apt lists go with the layer they
 * were fetched for — a cached index in the image is bytes on the cold-start
 * path of every sandbox, and stale within a day besides.
 *
 * An empty list returns the base image UNTOUCHED rather than emitting an
 * `apt-get install` with no arguments: that command fails, and it would fail
 * inside an image build whose error surfaces as a failed spawn.
 */
export function systemPackagesImage(baseImage: Image, systemPackages: readonly string[]): Image {
  if (systemPackages.length === 0) return baseImage;
  return baseImage.dockerfileCommands([
    "RUN apt-get update && apt-get install -y --no-install-recommends " +
      `${systemPackageList(systemPackages)} && rm -rf /var/lib/apt/lists/*`,
  ]);
}

/**
 * The system packages as one canonical string — SORTED, so reordering the
 * declaration is not a change.
 *
 * One function because two callers must agree exactly: the `apt-get install`
 * line and the image FINGERPRINT. Deriving them separately is how a package
 * joins the layer without minting a new tag, and the symptom of that is the
 * worst one available here — every already-published snapshot keeps its tag, so
 * spawns resolve an image that silently lacks the binary a step calls.
 */
export function systemPackageList(systemPackages: readonly string[]): string {
  return [...systemPackages].sort().join(" ");
}
