// Copyright 2026 the AAI authors. MIT license.
// The npm policy every guest spawn site shares. The two suites that drive npm
// (studio-project-tools-mocked, studio-workspace-deps) mock `runNpm` and
// assert only the verb and spec they own, so the standing flags, the cwd and
// the token-free env are pinned here — once — rather than restated at each
// call site the way they were when the two copies drifted.
//
// These run REAL npm, which is why they only ask it to read its own config:
// `npm config get` is local, needs no network, and is the one command that
// reports back what flags it was given.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { useTempDir } from "./_test-utils.ts";
import {
  envWithoutGuestToken,
  NPM_OUTPUT_CAP,
  NPM_TIMEOUT_MS,
  PACKAGE_NAME_RE,
  runNpm,
} from "./studio-spawn.ts";

const dir = useTempDir("aai-spawn-");

describe("runNpm", () => {
  test.for([
    ["audit", "false"],
    ["fund", "false"],
    ["loglevel", "error"],
  ])("passes --%s through to npm", async ([key, want]) => {
    const result = await runNpm(dir(), ["config", "get", key as string]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(want);
  });

  test("runs in the directory it is given", async () => {
    // `npm prefix` reports the nearest ANCESTOR holding a `package.json` or a
    // `node_modules`, not the cwd — so without one of those in `dir()` the answer
    // depends on what happens to sit above the temp directory. That is a real
    // flake and not a hypothetical: under `turbo run`, strict env mode strips
    // TMPDIR, `os.tmpdir()` falls back to `/tmp`, and a stray
    // `/tmp/node_modules` makes npm answer `/private/tmp`. Writing a manifest
    // here stops the walk at `dir()` whatever is above it. (TMPDIR is passed
    // through in turbo.json now too — the two fixes are independent.)
    await writeFile(path.join(dir(), "package.json"), '{"name":"probe","version":"1.0.0"}');
    const result = await runNpm(dir(), ["prefix"]);
    // macOS reports /private/var for /var; compare the resolved leaf instead.
    expect(result.stdout.trim().endsWith(path.basename(dir()))).toBe(true);
  });

  test("the timeout and cap are one pair, not two that must be kept in step", () => {
    // They were duplicated under a second name (INSTALL_TIMEOUT_MS /
    // INSTALL_OUTPUT_CAP) with nothing asserting the copies agreed.
    expect({ timeout: NPM_TIMEOUT_MS, cap: NPM_OUTPUT_CAP }).toEqual({
      timeout: 110_000,
      cap: 4000,
    });
  });
});

describe("envWithoutGuestToken", () => {
  test("strips the control-channel bearer so workspace code cannot impersonate the host", () => {
    vi.stubEnv("AAI_GUEST_TOKEN", "secret");
    expect(envWithoutGuestToken().AAI_GUEST_TOKEN).toBeUndefined();
  });

  test("leaves the rest of the environment alone", () => {
    vi.stubEnv("AAI_SPAWN_TEST_MARKER", "kept");
    expect(envWithoutGuestToken().AAI_SPAWN_TEST_MARKER).toBe("kept");
  });
});

describe("PACKAGE_NAME_RE", () => {
  test.for(["date-fns", "ms", "@alexkroman1/aai", "@scope/name.with-dots"])(
    "%s is a package name",
    (name) => {
      expect(PACKAGE_NAME_RE.test(name)).toBe(true);
    },
  );

  test.for(["date-fns@4", "--registry", "../local", "@scope", "UPPER"])(
    "%s is not a package name",
    (name) => {
      expect(PACKAGE_NAME_RE.test(name)).toBe(false);
    },
  );
});
