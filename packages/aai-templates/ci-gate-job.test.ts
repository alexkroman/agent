// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards the `ci` job in `.github/workflows/check.yml` — the SINGLE required
 * check that branch protection is pointed at.
 *
 * Four specs in this package already read `check.yml`, and every one of them
 * asks the same narrow question: does this gate's NAME still appear somewhere
 * in the file? None looked at the job that decides whether the workflow passed,
 * and that job had two defects at once:
 *
 * - **`setup` was not in `needs`.** All five real jobs declare `needs: setup`,
 *   so a broken lockfile or a failing `turbo run build` fails `setup` and
 *   GitHub reports every downstream job as `skipped` — a result the gate never
 *   looked at, because the job that produced it was not among its dependencies.
 * - **`"skipped"` was accepted as a pass.** Under `if: always()` the two
 *   compose: `setup` fails, all five downstream jobs report `skipped`, the loop
 *   accepts every one of them, prints "All CI jobs passed" and exits 0. A green
 *   required check over a tree that was never built and never tested.
 *
 * That is the same failure shape the ratchets in this package are specced
 * against — something green that checked nothing — sitting on the one check
 * protecting `main`, so it belongs here beside them rather than in a comment.
 *
 * It lives in aai-templates for the reason its sibling gate specs do: this
 * package already owns the tests for repo-level wiring, and `?raw` imports
 * reach the workflow with no node types, which this package's tsconfig has none
 * of.
 *
 * The parsing is deliberately not a YAML library. Three facts are read — the
 * job names, one `needs:` list and one shell loop — this package carries no
 * YAML parser, and a malformed file fails the shape assertions below anyway.
 */

import { describe, expect, test } from "vitest";

const workflow = import.meta.glob("../../.github/workflows/check.yml", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../.github/workflows/check.yml"];

const lines = (): string[] => (workflow ?? "").split("\n");

/** Every job key: a two-space-indented name with nothing after the colon. */
function jobNames(): string[] {
  const all = lines();
  const start = all.indexOf("jobs:");
  if (start === -1) throw new Error("check.yml has no top-level `jobs:` block");
  return all
    .slice(start + 1)
    .map((line) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** The body of one job, from its key to the next job key (or end of file). */
function jobBody(name: string): string {
  const all = lines();
  const at = all.indexOf(`  ${name}:`);
  if (at === -1) throw new Error(`check.yml has no job named ${name}`);
  const rest = all.slice(at + 1);
  const next = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return (next === -1 ? rest : rest.slice(0, next)).join("\n");
}

/** The `needs: [...]` list of a job, in declaration order. */
function needsOf(name: string): string[] {
  const found = /^\s*needs:\s*\[([^\]]*)\]/m.exec(jobBody(name));
  if (found === null) throw new Error(`the ${name} job declares no bracketed \`needs:\``);
  return (found[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

describe("the ci gate job", () => {
  test("the workflow is readable and declares several jobs", () => {
    expect(workflow, ".github/workflows/check.yml not found").toBeTypeOf("string");
    // A floor, for the reason every gate in this package carries one: an empty
    // parse would make every assertion below a statement about nothing, and
    // "the gate needs every job" is vacuously true of no jobs.
    expect(jobNames().length, "no jobs parsed out of check.yml").toBeGreaterThanOrEqual(6);
    expect(jobNames(), "the required gate job is gone").toContain("ci");
  });

  test("its needs cover EVERY other job in the workflow", () => {
    // `setup` was the one missing, and it is the one whose failure the gate most
    // needs to see: every other job depends on it, so its failure arrives
    // downstream as `skipped` rather than as a failure of anything the gate was
    // watching.
    //
    // Derived from the parsed job list rather than a hand-kept array, so a NEW
    // job is covered on the day it is added — a list here would rot exactly the
    // way the one in the workflow did.
    const others = jobNames().filter((name) => name !== "ci");
    expect(others.length, "no non-gate jobs parsed").toBeGreaterThanOrEqual(5);
    for (const job of others) {
      expect(
        needsOf("ci"),
        `the ci gate does not depend on "${job}", so that job's failure cannot fail the gate`,
      ).toContain(job);
    }
  });

  test("every job it depends on is read in the result check", () => {
    // `needs` alone only ORDERS the job. A dependency whose `result` is never
    // interpolated into the loop's input is watched by nothing, which is a
    // second route to the same green-over-a-failure outcome.
    const body = jobBody("ci");
    for (const job of needsOf("ci")) {
      expect(body, `the ci gate never reads needs.${job}.result`).toContain(`needs.${job}.result`);
    }
  });

  test("it does not accept a skipped job as a pass", () => {
    // The other half of the defect. No downstream job carries an `if:` condition
    // of any kind, so `skipped` can only ever mean "a dependency failed" — and
    // accepting it is what turned a failed `setup` into "All CI jobs passed".
    //
    // Asserted on the STRING the shell compares: a job that legitimately skips
    // ITSELF needs its own accepted-result handling, never a blanket allowance
    // restored here.
    expect(
      jobBody("ci"),
      'the ci gate accepts "skipped" again — a failed `setup` makes every other job skip',
    ).not.toContain('"skipped"');
  });

  test("it fails the run rather than only reporting", () => {
    const body = jobBody("ci");
    expect(body, "the ci gate no longer runs `if: always()`").toContain("if: always()");
    // Without a non-zero exit the job is decorative: branch protection reads the
    // job's conclusion and nothing else.
    expect(body, "the ci gate never exits non-zero").toContain("exit 1");
    expect(body, "the ci gate no longer compares against success").toMatch(/!=\s*"success"/);
  });
});
