// Copyright 2026 the AAI authors. MIT license.
/**
 * `guest-image.Dockerfile` says the same thing as the constants it mirrors.
 *
 * The Dockerfile is the OCI form of the recipe `modal-harness-image.ts` used to
 * assemble through Modal's image builder, and the values it needs are supplied
 * by `scripts/build-guest-image.mjs`, which READS them out of these same
 * modules. Two of them cannot be supplied that way — the base image and the
 * guest root are `ARG` defaults, so a bare `docker build` works and buildx does
 * not warn — and a committed copy is exactly what goes stale here. This is the
 * gate under it, in the shape `check:scaffold` and the guide-cap test use.
 *
 * The rest is the structure a reviewer cannot see at a glance and that a
 * refactor can silently lose. The layer ORDER is load-bearing (the halves change
 * at completely different rates, so the harness must land last or every rebuild
 * reinstalls the toolchain); `--ignore-scripts` on BOTH npm steps is a security
 * property with an argument behind it; and the two ARGs that must have NO
 * default are the two whose values change every release, where a stale default
 * builds a wrong image in silence rather than failing.
 *
 * A filesystem read is unit-legal, so this runs in the ordinary test run — an
 * agent editing either side sees it without knowing the gate exists.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "./modal-context.ts";
import {
  GUEST_ROOT,
  HARNESS_COMPILE_CACHE_PATH,
  HARNESS_REMOTE_PATH,
} from "./modal-harness-image.ts";
import { GUEST_SYSTEM_PACKAGES } from "./modal-system-packages.ts";

const DOCKERFILE = readFileSync(
  path.join(import.meta.dirname, "..", "guest-image.Dockerfile"),
  "utf-8",
);

/**
 * A literal `${NAME}` Dockerfile substitution.
 *
 * Spelled through a template escape so lint reads it as the DATA it is rather
 * than as a JS placeholder somebody forgot to interpolate
 * (`noTemplateCurlyInString`) — which is cheaper than spending an escape hatch
 * on a rule that is right everywhere else.
 */
const argRef = (name: string): string => `$\{${name}}`;

/** Lines that actually build something — comments carry prose about them. */
const instructions = DOCKERFILE.split("\n").filter((l) => !l.trimStart().startsWith("#"));

/** Index of the first instruction matching `re`, or -1. */
const at = (re: RegExp): number => instructions.findIndex((l) => re.test(l));

describe("guest-image.Dockerfile agrees with the recipe constants", () => {
  test("the ARG defaults are the committed copies of the constants", () => {
    expect(DOCKERFILE).toContain(`ARG BASE_IMAGE=${DEFAULT_SANDBOX_IMAGE}`);
    expect(DOCKERFILE).toContain(`ARG GUEST_ROOT=${GUEST_ROOT}`);
  });

  test("the harness and its compile cache land where the spawner looks", () => {
    // The spawner execs HARNESS_REMOTE_PATH and points NODE_COMPILE_CACHE at
    // HARNESS_COMPILE_CACHE_PATH (guestExecBaseEnv). Both are derived from
    // GUEST_ROOT in TS and written through the ARG here, so compare resolved.
    const resolved = DOCKERFILE.replaceAll(argRef("GUEST_ROOT"), GUEST_ROOT);
    expect(resolved).toContain(`COPY dist/harness.mjs ${HARNESS_REMOTE_PATH}`);
    expect(resolved).toContain(`NODE_COMPILE_CACHE=${HARNESS_COMPILE_CACHE_PATH}`);
    expect(resolved).toContain(`node ${HARNESS_REMOTE_PATH}`);
  });

  test("the system packages arrive as an ARG rather than a second declaration", () => {
    // GUEST_SYSTEM_PACKAGES is the one source; a package name spelled here too
    // would be the drift this file exists to prevent.
    for (const pkg of GUEST_SYSTEM_PACKAGES) {
      expect(instructions.join("\n")).not.toContain(pkg);
    }
    expect(DOCKERFILE).toContain(
      `apt-get install -y --no-install-recommends ${argRef("SYSTEM_PACKAGES")}`,
    );
  });

  test("the two ARGs whose values change every release carry NO default", () => {
    // A stale default would build an image with the wrong SDK — green build,
    // wrong runtime. Absent, the guards below fail the build instead.
    expect(DOCKERFILE).toMatch(/^ARG SYSTEM_PACKAGES$/m);
    expect(DOCKERFILE).toMatch(/^ARG SDK_SPECS$/m);
  });

  test("an empty ARG fails the build rather than building something else", () => {
    // Docker substitutes an empty string for an unset ARG; it does not error.
    for (const name of ["SYSTEM_PACKAGES", "SDK_SPECS"]) {
      expect(DOCKERFILE).toContain(`test -n "${argRef(name)}"`);
    }
  });

  test("neither npm step runs a dependency's install scripts", () => {
    const npmSteps = instructions.filter((l) => l.includes("npm ci") || l.includes("npm install"));
    expect(npmSteps).toHaveLength(2);
    for (const step of npmSteps) expect(step).toContain("--ignore-scripts");
  });

  test("the layers are ordered cheapest-to-invalidate last", () => {
    const apt = at(/apt-get install/);
    const npmCi = at(/npm ci/);
    const tarballs = at(/^COPY sdk-tarballs\//);
    const sdk = at(/npm install --prefix/);
    const harness = at(/^COPY dist\/harness\.mjs/);
    const warmup = at(/AAI_GUEST_WARMUP=1/);
    expect(apt).toBeGreaterThanOrEqual(0);
    // Every step must come after the one whose cache it must not invalidate.
    expect(npmCi).toBeGreaterThan(apt);
    // The tarballs change on every LOCAL build, so they must land after the
    // committed-lockfile install and before the SDK install that reads them.
    expect(tarballs).toBeGreaterThan(npmCi);
    expect(sdk).toBeGreaterThan(tarballs);
    expect(harness).toBeGreaterThan(sdk);
    expect(warmup).toBeGreaterThan(harness);
  });

  test("the tarball directory the COPY needs is COMMITTED, not just gitignored", () => {
    // A Dockerfile cannot branch, so that COPY runs for a published build too —
    // and `COPY` of a path outside the context fails the build. The `.tgz` files
    // are build output and ignored; the directory has to survive a clean clone,
    // which is what the `.gitkeep` is for. Deleting it breaks every image build
    // including production's, with an error naming a context-relative path.
    const keep = path.join(
      import.meta.dirname,
      "..",
      "..",
      "aai-guest",
      "sdk-tarballs",
      ".gitkeep",
    );
    expect(existsSync(keep)).toBe(true);
  });

  test("`predev` rebuilds the image, so a dev server cannot serve a stale microVM", () => {
    // The wiring, not the logic. A microVM boots a BAKED image, so a stale one
    // serves code nobody in the tree wrote — and it is invisible from every
    // angle a developer checks: `ensure-guest-harness.mjs` reports a fresh
    // `dist/harness.mjs`, the bundle contains the change, and the guest runs
    // neither. That cost two investigations, the second on an image two days
    // old. A wiring line silently dropped from a package script is exactly the
    // failure this repo keeps finding, so it is asserted rather than trusted.
    const studio = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "..", "..", "aai-studio-server", "package.json"),
        "utf-8",
      ),
    ) as { scripts?: Record<string, string> };
    const predev = studio.scripts?.predev ?? "";
    expect(predev).toContain("ensure-guest-image.mjs");
    // AFTER the harness build, which produces the input it fingerprints.
    expect(predev.indexOf("ensure-guest-image.mjs")).toBeGreaterThan(
      predev.indexOf("ensure-guest-harness.mjs"),
    );
    expect(
      existsSync(
        path.join(import.meta.dirname, "..", "..", "..", "scripts", "ensure-guest-image.mjs"),
      ),
    ).toBe(true);
  });

  test("the compile-cache warm-up is best-effort", () => {
    // The cache is an optimization; the image without it is a working image, so
    // a warm-up failure must not fail the build (it warns instead).
    const warmup = instructions.slice(at(/AAI_GUEST_WARMUP=1/)).join("\n");
    expect(warmup).toMatch(/\|\|/);
    expect(warmup).toContain("WARN");
  });
});
