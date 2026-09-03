// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `ensure-guest-image.mjs` records the fingerprint of the tree the build LEFT,
 * never the one it found.
 *
 * The gate hashes `packages/*.../dist` (`sdkSourceDigest`) among its inputs, and
 * the build it spawns is not a read-only operation on them: `build-guest-image
 * .mjs` runs `packWorkspaceSdk`, which runs `turbo run build` over the four SDK
 * packages and rewrites those very trees. Taking the digest before the build and
 * recording THAT therefore stamped a state the build had already moved past — so
 * the next run computed a different digest, called the image stale, and paid a
 * second full rebuild. Measured on the real tree with the exact command the build
 * spawns: `eefe440a…` before, `0b692d80…` after, stable across a second build.
 * That is ~46s off the first run of a developer's dev loop, every time, on a gate
 * whose entire purpose is to not spend it.
 *
 * Two properties, and they pull in opposite directions, which is why the fix is
 * an ORDERING rather than a one-line move: the digest a rebuild is DECIDED from
 * has to describe the tree as the caller found it, and the digest RECORDED has to
 * describe the tree the build produced. A single reading cannot be both.
 *
 * Asserted through the script's injected `io` rather than by running it: the real
 * thing needs docker, microsandbox and ~46 seconds, and none of that is what is
 * being checked here. The seam exists for this — see `REAL_IO`'s own doc.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

/** The subset of the script's `io` seam these cases drive. */
type EnsureIo = {
  hasHarness: () => boolean;
  fingerprint: () => string;
  readStamp: () => { inputs: string; imageId?: string } | undefined;
  imageId: () => string | undefined;
  build: () => boolean;
  writeStamp: (inputs: string, imageId: string | undefined) => void;
};

/**
 * The one value a single-file glob resolved to.
 *
 * `import.meta.glob` is a compile-time transform, so its pattern must be a
 * literal and the result is a one-entry record keyed by it. `| undefined` is
 * deliberate: a pattern that stopped resolving must fail the assertions below
 * rather than pass as nothing. Same helper, same reason, as
 * `guest-image-extractors.test.ts`.
 */
const sole = <T>(module: Record<string, T>): T | undefined => Object.values(module)[0];

const main = sole(
  import.meta.glob<(argv: string[], io: EnsureIo) => number>(
    "../../../scripts/ensure-guest-image.mjs",
    { import: "main", eager: true },
  ),
);

/**
 * An `io` whose fingerprint CHANGES across the build, which is the real thing's
 * behaviour and the whole subject here.
 *
 * `build` flips the reading rather than a test flipping it by hand, so the fake
 * cannot drift into a shape where the two digests differ for some reason other
 * than the build — which is the only reason they ever differ in production.
 */
function ioWith(over: Partial<EnsureIo> = {}) {
  let built = false;
  const writeStamp = vi.fn();
  const fingerprint = vi.fn(() => (built ? "after-build" : "before-build"));
  const build = vi.fn(() => {
    built = true;
    return true;
  });
  const io: EnsureIo = {
    hasHarness: () => true,
    fingerprint,
    readStamp: () => undefined,
    imageId: () => "sha256:image",
    build,
    writeStamp,
    ...over,
  };
  return { io, writeStamp, fingerprint, build };
}

describe("ensure-guest-image records the post-build fingerprint", () => {
  beforeEach(() => {
    // The script narrates to `console` (it is a plain `.mjs`, so `logger.ts` is
    // not available to it) and its wording is not what these cases are about.
    // `restoreMocks` puts every one of these back before the next test.
    for (const level of ["log", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
  });

  test("the script's main is reachable", () => {
    // A floor: every case below is `main?.(...)`, so a glob that stopped
    // resolving would assert nothing at all and pass green.
    expect(main, "scripts/ensure-guest-image.mjs does not export main").toBeTypeOf("function");
  });

  test("the stamp carries the digest taken AFTER the build", () => {
    vi.stubEnv("SANDBOX_BACKEND", undefined);
    const { io, writeStamp, build } = ioWith();
    expect(main?.([], io)).toBe(0);
    expect(build).toHaveBeenCalledTimes(1);
    // The bug, stated as the thing that must not be true: recording
    // "before-build" is what made the next run rebuild.
    expect(writeStamp).toHaveBeenCalledWith("after-build", "sha256:image");
  });

  test("the DECISION still reads the tree as the caller found it", () => {
    vi.stubEnv("SANDBOX_BACKEND", undefined);
    // A stamp matching the PRE-build digest means nothing changed, so no build is
    // owed — and a version that only moved the reading later would take the
    // post-build digest for the comparison too, rebuild once, and then be
    // permanently current for the wrong reason. Both halves are load-bearing.
    const { io, build, writeStamp } = ioWith({
      readStamp: () => ({ inputs: "before-build", imageId: "sha256:image" }),
    });
    expect(main?.([], io)).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  test("a run that rebuilds takes the digest TWICE", () => {
    vi.stubEnv("SANDBOX_BACKEND", undefined);
    const { io, fingerprint } = ioWith();
    main?.([], io);
    // One for the decision, one for the record. A single call is the old shape
    // whichever end of the build it sat at.
    expect(fingerprint).toHaveBeenCalledTimes(2);
  });

  test("a build that FAILS records nothing", () => {
    vi.stubEnv("SANDBOX_BACKEND", undefined);
    const { io, writeStamp } = ioWith({ build: () => false });
    // Still exit 0 — a developer with no docker gets a dev server, and the
    // server's own boot check is the backstop. What must not happen is a stamp,
    // because the next run would then skip a build that never happened.
    expect(main?.([], io)).toBe(0);
    expect(writeStamp).not.toHaveBeenCalled();
  });

  test("--check reports staleness and records nothing", () => {
    vi.stubEnv("SANDBOX_BACKEND", undefined);
    const { io, build, writeStamp } = ioWith();
    expect(main?.(["--check"], io)).toBe(1);
    expect(build).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  test("a missing harness skips without recording", () => {
    vi.stubEnv("SANDBOX_BACKEND", undefined);
    // Ordering rather than an error: `predev` runs `ensure-guest-harness.mjs`
    // first. A stamp here would describe an image that was never built.
    const { io, build, writeStamp } = ioWith({ hasHarness: () => false });
    expect(main?.([], io)).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });

  test("the subprocess backend needs no image and records none", () => {
    vi.stubEnv("SANDBOX_BACKEND", "subprocess");
    const { io, build, writeStamp } = ioWith();
    expect(main?.([], io)).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(writeStamp).not.toHaveBeenCalled();
  });
});
