// Copyright 2025 the AAI authors. MIT license.

/**
 * Which package manager `aai init` installs with, and how it invokes it.
 *
 * Split out of `init.test.ts` when that file crossed the 700-line cap: these
 * two groups are pure functions over a user-agent string and a PATH probe, so
 * they need none of that suite's templates-root, prompt or execa scaffolding.
 */

import { describe, expect, test, vi } from "vitest";
import {
  detectPackageManager,
  packageManagerFromUserAgent,
  resolveInstallCommand,
} from "./init.ts";

/**
 * Pin the invoking manager for a spec.
 *
 * `npm_config_user_agent` is set by whatever ran this suite — pnpm in CI — and
 * detection reads it FIRST, so a spec that does not stub it is asserting about
 * the machine rather than about the code.
 */
function stubUserAgent(ua: string | undefined): void {
  vi.stubEnv("npm_config_user_agent", ua ?? "");
}

describe("resolveInstallCommand", () => {
  test("uses safe-chain when available", async () => {
    const result = await resolveInstallCommand("pnpm", () => Promise.resolve(true));
    expect(result.cmd).toBe("safe-chain");
    expect(result.args).toContain("pnpm");
    expect(result.args).toContain("--safe-chain-skip-minimum-package-age");
  });

  test("falls back to pnpm when safe-chain is not available", async () => {
    const result = await resolveInstallCommand("pnpm", () => Promise.resolve(false));
    expect(result.cmd).toBe("pnpm");
    expect(result.args).not.toContain("--safe-chain-skip-minimum-package-age");
  });

  test.each(["npm", "bun", "yarn"] as const)(
    "%s runs directly, with no safe-chain probe",
    async (pm) => {
      // The routing exists for pnpm's `--safe-chain-skip-minimum-package-age`,
      // which the scaffold's freshly-published pins need and which no other
      // manager has an equivalent for — so probing for it would be a subprocess
      // spent on a flag that cannot be passed.
      const probe = vi.fn(() => Promise.resolve(true));
      expect(await resolveInstallCommand(pm, probe)).toEqual({ cmd: pm, args: [] });
      expect(probe).not.toHaveBeenCalled();
    },
  );
});

describe("detectPackageManager", () => {
  /**
   * The bug this group exists for: `init` installed with pnpm unconditionally,
   * reaching it through `corepack enable` — and corepack ships with no Node
   * >= 25, half the range the scaffold's `engines` allow. So the documented
   * install path (`npm i -g @alexkroman1/aai-cli`) produced a project whose
   * install step needed a manager the user had never been asked to have, and
   * the generated README then said `npm install` beside a pnpm lockfile.
   */
  test.each([
    ["pnpm/10.29.3 npm/? node/v24.10.0 linux x64", { name: "pnpm", version: "10.29.3" }],
    ["npm/10.9.2 node/v25.1.0 linux x64", { name: "npm", version: "10.9.2" }],
    ["bun/1.2.4 npm/? node/v24.10.0 linux x64", { name: "bun", version: "1.2.4" }],
    ["yarn/4.6.0 npm/? node/v24.10.0 linux x64", { name: "yarn", version: "4.6.0" }],
  ])("takes the manager that invoked it: %s", async (ua, expected) => {
    // The probe must never run — the invoking manager is on PATH by definition.
    const probe = vi.fn(() => Promise.resolve(undefined));
    expect(await detectPackageManager(ua, probe)).toEqual(expected);
    expect(probe).not.toHaveBeenCalled();
  });

  test("a version the manifest could not use is dropped rather than pinned", async () => {
    // `packageManager` takes `name@version` and corepack REFUSES a value it
    // cannot parse, so `npm/?` must produce no pin at all.
    expect(packageManagerFromUserAgent("npm/? node/v24.10.0")).toEqual({ name: "npm" });
  });

  test.each(["deno/2.1.4 node/v24.10.0", "", undefined])(
    "an unrecognized user agent (%o) falls through to the PATH probe",
    async (ua: string | undefined) => {
      // Stubbed as well as passed: the parameter DEFAULTS to the real variable,
      // so passing `undefined` reads the machine's own agent rather than none.
      stubUserAgent(ua);
      const probe = vi.fn((name: string) => Promise.resolve(name === "npm" ? "10.9.2" : undefined));
      expect(await detectPackageManager(ua, probe)).toEqual({ name: "npm", version: "10.9.2" });
    },
  );

  test("pnpm stays the PREFERENCE when several are on PATH", async () => {
    stubUserAgent(undefined);
    const probe = vi.fn(() => Promise.resolve("1.0.0"));
    expect(await detectPackageManager(undefined, probe)).toEqual({
      name: "pnpm",
      version: "1.0.0",
    });
    // First hit wins, so nothing after pnpm is even spawned.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("a manager present but silent about its version is still used", async () => {
    // "" means present-without-a-pinnable-version; `undefined` means absent.
    // Conflating them would skip a manager that is installed and working.
    stubUserAgent(undefined);
    const probe = vi.fn((name: string) => Promise.resolve(name === "bun" ? "" : undefined));
    expect(await detectPackageManager(undefined, probe)).toEqual({ name: "bun" });
  });

  test("falls back to npm when nothing answers, because every Node ships one", async () => {
    stubUserAgent(undefined);
    expect(await detectPackageManager(undefined, () => Promise.resolve(undefined))).toEqual({
      name: "npm",
    });
  });
});
