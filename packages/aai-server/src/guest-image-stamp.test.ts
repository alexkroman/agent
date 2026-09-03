// Copyright 2026 the AAI authors. MIT license.
/**
 * The local guest image's staleness stamp, whose filename is spelled TWICE.
 *
 * `scripts/build-guest-image.mjs` writes it and `service-boot.ts` reads it, and
 * they cannot share a constant: the script is plain `.mjs` run by node with no
 * bundler and no loader, so importing one out of a TypeScript module is not
 * available to it. Two spellings of one filename is the ordinary hazard, and the
 * failure it produces is the quiet kind — the reader finds no stamp, reports the
 * image as unverifiable forever, and the warning becomes noise nobody acts on.
 *
 * The check the stamp exists FOR is the one that cost real time: the local tag
 * is mutable, so an image and the harness beside it drift with nothing saying
 * so, and a two-day-old image served pre-change code through an hour of manual
 * testing while reporting an SDK version one release back.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf-8");
}

const script = read("scripts/build-guest-image.mjs");
const boot = read("packages/aai-server/src/service-boot.ts");

/** The one string both sides have to agree on. */
const STAMP = ".guest-image-stamp.json";

describe("the guest image stamp", () => {
  test("is named the same in the writer and the reader", () => {
    expect(script).toContain(`const GUEST_IMAGE_STAMP = "${STAMP}"`);
    expect(boot).toContain(`const GUEST_IMAGE_STAMP = "${STAMP}"`);
  });

  test("records the harness digest under the key the reader looks up", () => {
    // A stamp whose shape drifted would parse, miss the key, and report every
    // image as stale — a warning that is always on is a warning nobody reads.
    expect(script).toContain("harnessSha256");
    expect(boot).toContain("harnessSha256");
  });

  test("is written only after the image really reached microsandbox", () => {
    // Stamping an image that failed to load would claim a freshness nothing has.
    expect(script).toMatch(/if \(load\.status === 0\) writeImageStamp\(tag\);/);
  });

  test("is checked at boot, after the missing-image branch rather than instead", () => {
    // The two are different failures with different remedies, and the missing
    // one must still be reported by name.
    expect(boot).toContain("warnOnStaleGuestImage()");
    expect(boot).toContain("no local guest image for the microsandbox backend");
  });

  test("names the command that fixes it", () => {
    // The whole value of the warning is that the remedy is one line away.
    expect(boot).toContain("pnpm build:guest-image --msb");
  });
});
