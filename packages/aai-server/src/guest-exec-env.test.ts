// Copyright 2026 the AAI authors. MIT license.
/**
 * `TMPDIR` has ONE home, and this is what keeps it there.
 *
 * The behavioural half is elsewhere and per backend: `modal-sandbox.test.ts` and
 * `microsandbox-sandbox.test.ts` each assert the key really is in the env their
 * spawn execs with. What no behavioural test can see is a FOURTH builder setting
 * it — the state this file was written out of, where the value sat in
 * `agentBootEnv` and in both studio spawn sites at once because
 * `guestExecBaseEnv` was one line from its file's 500-line cap. Every one of the
 * three was individually correct and passing.
 *
 * So the guards here are a text scan, in the genre of
 * `pg-cron-delete-parity.test.ts` and `store-conformance-registry.test.ts`: a
 * NAME-level refusal to let a second copy appear quietly. It cannot prove the
 * four sites agree on anything; it can only make a divergence a failing test
 * rather than a diff nobody reads.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONTAINED_ENV } from "@alexkroman1/aai-runtime/internal";
import { describe, expect, test } from "vitest";
import {
  GUEST_ROOT,
  GUEST_SCRATCH_DIR,
  guestExecBaseEnv,
  HARNESS_COMPILE_CACHE_PATH,
} from "./guest-exec-env.ts";

/** The four exec sites that spawn a guest inside a real container. */
const CONTAINED_SPAWNERS = [
  "modal-sandbox.ts",
  "modal-agent-sandbox.ts",
  "microsandbox-sandbox.ts",
  "microsandbox-agent-sandbox.ts",
] as const;

/**
 * The one spawner that must NOT take this env.
 *
 * Its guest is a child process on a developer's own machine, so neither the
 * containment declaration nor `/var/tmp` is true of it — and that literal is
 * drive-relative on Windows, the trap `guard-invariants` rule 11 exists for.
 */
const UNCONTAINED_SPAWNER = "subprocess-sandbox.ts";

const source = (file: string): string =>
  readFileSync(path.join(import.meta.dirname, file), "utf-8");

/**
 * Every non-test `.ts` in this package, so a new builder is in the corpus by
 * DEFAULT.
 *
 * A hand-kept list is the failure this whole file is about: the scan would go on
 * printing a checkmark while the copy it exists to find sat in the file nobody
 * added. Specs are excluded because two of them are named
 * `"names no TMPDIR: …"` — a test TITLE is prose, and no substring pattern can
 * tell it from a key. The corpus is FLOORED for the reason every counting gate in
 * this repo is: a `readdirSync` that stopped matching would scan nothing and pass.
 * Measured at 131 non-test sources; the floor sits under that.
 */
function packageSources(): string[] {
  const files = readdirSync(import.meta.dirname).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  if (files.length < 120) {
    throw new Error(`only ${files.length} sources found in ${import.meta.dirname}`);
  }
  return files;
}

describe("guestExecBaseEnv", () => {
  test("is the compile cache, the containment flag, and the scratch directory", () => {
    expect(guestExecBaseEnv()).toEqual({
      NODE_COMPILE_CACHE: HARNESS_COMPILE_CACHE_PATH,
      [CONTAINED_ENV]: "1",
      TMPDIR: GUEST_SCRATCH_DIR,
    });
  });

  test("points scratch space at the overlay, not the microVM's 512 MiB tmpfs", () => {
    // `/var/tmp` belongs to the shared base IMAGE rather than to either sandbox
    // runtime, which is what makes one value right for both — see the constant's
    // own doc for the measurement (`MemAvailable` fell 508,632 kB across a
    // 512 MiB write to `/tmp` and not at all for the same write here).
    expect(GUEST_SCRATCH_DIR).toBe("/var/tmp");
    expect(HARNESS_COMPILE_CACHE_PATH.startsWith(`${GUEST_ROOT}/`)).toBe(true);
  });
});

describe("one home", () => {
  /**
   * The scan that would have failed on the three-builder state.
   *
   * `TMPDIR:` as an object KEY is what a builder writes; a `process.env.TMPDIR`
   * read or a mention in prose is not, so the pattern is deliberately the
   * key-with-colon form and nothing wider.
   */
  test("no module in this package sets TMPDIR but this one", () => {
    const setters = packageSources().filter((file) => /(^|[\s{,])TMPDIR:/.test(source(file)));
    expect(setters).toEqual(["guest-exec-env.ts"]);
  });

  test.each(CONTAINED_SPAWNERS)("%s builds its exec env from guestExecBaseEnv()", (file) => {
    // The value reaches all four sites BECAUSE they spread the one builder. A site
    // that stops doing so silently loses the scratch directory, the compile cache
    // and the containment flag together.
    expect(source(file)).toContain("...guestExecBaseEnv()");
  });

  test("the subprocess backend takes neither the env nor the scratch directory", () => {
    // It names what it needs one key at a time; see UNCONTAINED_SPAWNER. Asserted
    // as a NON-import so the refusal survives the function being renamed.
    const text = source(UNCONTAINED_SPAWNER);
    expect(text).not.toContain("...guestExecBaseEnv()");
    expect(text).not.toContain(`"${GUEST_SCRATCH_DIR}"`);
  });
});
