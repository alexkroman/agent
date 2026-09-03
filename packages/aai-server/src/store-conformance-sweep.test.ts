// Copyright 2026 the AAI authors. MIT license.
/**
 * A conformance sweep may only ever delete what its OWN process wrote.
 *
 * Two packages run a conformance suite over the platform tables —
 * `aai-server`'s and `aai-studio-server`'s — and turbo runs them in PARALLEL
 * against one database. Both ended in an `afterAll` sweeping
 * `scope like 'conf-%'`, which matches the other suite's LIVE rows;
 * `studio_chats` cascades off `studio_workspaces`, so whichever finished first
 * deleted the other's parent workspace mid-run and the chat under it went with
 * it. It presented as `getChat` returning `null` for a row just written, on one
 * of the two scoped-chat assertions, intermittently — green on a re-run and
 * green on either suite alone, which is what kept it looking like flake.
 *
 * The fix is a per-process key prefix. This guards it, because the fix is
 * invisible: a sweep that goes back to `conf-%` deletes the same rows on a
 * single-suite run and fails nothing until two suites overlap again.
 *
 * A TEXT scan, like `store-conformance-registry.test.ts` beside it, and for the
 * same reason: the other file belongs to a package this one may not import.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CONFORMANCE_PREFIX, conformanceLike } from "./store-conformance.ts";

/** Both suites that sweep these tables, one of them a package over. */
const SWEEPERS = [
  "packages/aai-server/src/store-conformance.scenario.test.ts",
  "packages/aai-studio-server/src/studio-store-conformance.scenario.test.ts",
];

/** Repo root, from this file's own location. */
const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("a conformance sweep is scoped to its own process", () => {
  test.each(SWEEPERS)("%s sweeps no bare conf wildcard", (relative) => {
    const source = readFileSync(join(ROOT, relative), "utf8");
    // The literal that caused it, in any of the three columns it was written
    // against (`scope`, `slug`, `key`, `name`).
    expect(source).not.toMatch(/like\s+'conf-%'/);
    // And it really does still sweep — a file that stopped deleting anything
    // would pass the line above while leaving rows behind forever.
    expect(source).toContain("conformanceLike()");
  });

  test("the prefix carries the pid, so two processes cannot match each other", () => {
    expect(CONFORMANCE_PREFIX).toContain(String(process.pid));
    expect(conformanceLike()).toBe(`${CONFORMANCE_PREFIX}%`);
    // The claim that matters: another process's prefix is NOT matched by ours.
    const foreign = `conf-${process.pid + 1}-ws-abc-0`;
    expect(foreign.startsWith(CONFORMANCE_PREFIX)).toBe(false);
  });

  test("the studio package spells the SAME grammar, or the pids stop separating", () => {
    // The two constants are deliberately not shared — disjointness comes from
    // the pid rather than from an import — which means the grammar has to agree
    // by inspection. A studio prefix of `studio-conf-<pid>-` would still be
    // disjoint; one WITHOUT the pid would silently sweep our rows again.
    const studio = readFileSync(
      join(ROOT, "packages/aai-studio-server/src/studio-store-conformance.ts"),
      "utf8",
    );
    expect(studio).toMatch(/CONFORMANCE_PREFIX = `conf-\$\{process\.pid\}-`/);
  });
});
