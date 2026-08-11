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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  envWithoutGuestToken,
  NPM_OUTPUT_CAP,
  NPM_TIMEOUT_MS,
  PACKAGE_NAME_RE,
  runNpm,
} from "./studio-spawn.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "aai-spawn-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runNpm", () => {
  test.for([
    ["audit", "false"],
    ["fund", "false"],
    ["loglevel", "error"],
  ])("passes --%s through to npm", async ([key, want]) => {
    const result = await runNpm(dir, ["config", "get", key as string]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(want);
  });

  test("runs in the directory it is given", async () => {
    const result = await runNpm(dir, ["prefix"]);
    // macOS reports /private/var for /var; compare the resolved leaf instead.
    expect(result.stdout.trim().endsWith(path.basename(dir))).toBe(true);
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
