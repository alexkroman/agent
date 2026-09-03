// Copyright 2026 the AAI authors. MIT license.
/**
 * The committed guest toolchain declares no install script nobody vouched for.
 *
 * The image installs this lockfile with `--ignore-scripts`
 * (`aai-server/modal-harness-image.ts`), which is the right default — every
 * install-script package in this tree ships prebuilt platform binaries resolved
 * at require time, so their scripts only validate what is already installed,
 * and the alternative (`--strict-allow-scripts`) would turn a new one into a
 * failed image build, i.e. a failed spawn.
 *
 * What that trades away is the NOTICE: a future dependency whose install script
 * genuinely builds something would be skipped in silence and fail much later,
 * inside a guest, as a broken build tool. This is where that gets said out
 * loud — at commit time, on the half of the install that HAS a commit to review
 * (the `@alexkroman1/*` step resolves fresh at build time and is unlockable by
 * construction, which is exactly why it runs no scripts at all).
 *
 * A new entry is a decision, not a rebase conflict: confirm the package works
 * from its prebuilt artifact and add it below with the reason, or give the
 * toolchain an explicit build step.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Install-script packages this toolchain is known to carry, and why each is
 * harmless with its script skipped.
 */
const VOUCHED: Record<string, string> = {
  // darwin-only (`os: ["darwin"]`), so it is never installed in the linux
  // guest image at all — vite's optional file watcher.
  fsevents: "darwin-only optional dep; absent from the linux image",
};

/** The lockfile's `packages` map, keyed by install path. */
type LockPackages = Record<string, { hasInstallScript?: boolean; optional?: boolean }>;

function lockPackages(): LockPackages {
  const lock = fileURLToPath(new URL("../toolchain/package-lock.json", import.meta.url));
  const parsed = JSON.parse(readFileSync(lock, "utf-8")) as { packages?: LockPackages };
  return parsed.packages ?? {};
}

/** `node_modules/@scope/name` → `@scope/name` (the deepest segment pair). */
function packageName(path: string): string {
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  return at === -1 ? path : path.slice(at + marker.length);
}

describe("guest toolchain install scripts", () => {
  test("the lockfile is really being read", () => {
    // The whole assertion below is a set difference, so a parse that stopped
    // finding packages would compare nothing against nothing and pass. 143
    // entries today — it was 258 before the Workflow DevKit left, and the floor
    // TRACKS the real number rather than being relaxed to zero.
    expect(Object.keys(lockPackages()).length).toBeGreaterThan(120);
  });

  test("declares no install script that has not been vouched for", () => {
    const withScripts = Object.entries(lockPackages())
      .filter(([, entry]) => entry.hasInstallScript === true)
      .map(([path]) => packageName(path));

    expect([...new Set(withScripts)].sort()).toEqual(Object.keys(VOUCHED).sort());
  });
});
