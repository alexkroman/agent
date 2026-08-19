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

/** Split once — a dozen readers below walk the same file. */
const lines: string[] = (workflow ?? "").split("\n");

/** Where the `jobs:` block starts; everything above it is the trigger header. */
const jobsAt = lines.indexOf("jobs:");

/** A job KEY: a two-space-indented name with nothing after the colon. */
const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*$/;

/** A `[a, b, c]` flow sequence as its entries — `needs:` and `branches:` both. */
const bracketList = (inside: string | undefined): string[] =>
  (inside ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Every job key. */
function jobNames(): string[] {
  if (jobsAt === -1) throw new Error("check.yml has no top-level `jobs:` block");
  return lines
    .slice(jobsAt + 1)
    .map((line) => JOB_KEY.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Everything above `jobs:` — the triggers and the concurrency block. */
function header(): string {
  if (jobsAt === -1) throw new Error("check.yml has no top-level `jobs:` block");
  return lines.slice(0, jobsAt).join("\n");
}

/** The `branches: [...]` list belonging to the `push:` trigger. */
function pushBranches(): string[] {
  const found = /^\s*push:\s*\n\s*branches:\s*\[([^\]]*)\]/m.exec(header());
  if (found === null)
    throw new Error("check.yml declares no `push:` trigger with a bracketed `branches:`");
  return bracketList(found[1]);
}

/** The body of one job, from its key to the next job key (or end of file). */
function jobBody(name: string): string {
  const at = lines.indexOf(`  ${name}:`);
  if (at === -1) throw new Error(`check.yml has no job named ${name}`);
  const rest = lines.slice(at + 1);
  const next = rest.findIndex((line) => JOB_KEY.test(line));
  return (next === -1 ? rest : rest.slice(0, next)).join("\n");
}

/** The `needs: [...]` list of a job, in declaration order. */
function needsOf(name: string): string[] {
  const found = /^\s*needs:\s*\[([^\]]*)\]/m.exec(jobBody(name));
  if (found === null) throw new Error(`the ${name} job declares no bracketed \`needs:\``);
  return bracketList(found[1]);
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

  test("it runs on a push to main, so something evaluates the branch itself", () => {
    // The gate above is about a run REACHING a verdict. This is about a run
    // happening at all: with `main` absent from the push list every run of this
    // workflow was a `pull_request` evaluating a MERGE REF, so nothing anywhere
    // evaluated main — and `release.yml` / `deploy.yml` / `docs.yml`, which no
    // pull request runs, broke unreported (Release: 20 of 30 consecutive
    // pushes). Same silent-absence shape as the rest of this package's gates:
    // a green PR history that says nothing about the branch it merged into.
    expect(
      pushBranches(),
      "check.yml no longer runs on a push to main — nothing evaluates the branch, only merge refs",
    ).toContain("main");
  });

  test("it does not cancel superseded runs on a push", () => {
    // Cancelling is right for a pull request, where only the newest push is a
    // candidate. On a push it drops the verdict for a commit that is already on
    // the branch, which is worst exactly when merges are landing fastest — so
    // the setting has to be an expression scoped to pull requests, never a bare
    // `true`.
    const found = /^\s*cancel-in-progress:\s*(.+)$/m.exec(header());
    expect(found, "check.yml declares no `cancel-in-progress`").not.toBeNull();
    const value = found?.[1]?.trim() ?? "";
    expect(
      value,
      "cancel-in-progress is unconditional again — a push to main cancels the previous commit's verdict",
    ).not.toBe("true");
    expect(value, "cancel-in-progress is no longer scoped to pull requests").toContain(
      "pull_request",
    );
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

/**
 * The Postgres image pull, which is the one network fetch on the required path.
 *
 * Guarded because a retry loop that has stopped retrying looks EXACTLY like one
 * that works — the job is green either way until the registry throttles, and
 * then it is a red on the only required check with no test executed. That
 * happened three times across two PRs on 2026-08-18, all cleared by a rerun.
 */
describe("the Postgres image pull", () => {
  const pgStep = jobBody("integration-and-scenario");

  test("the pull is its own command, so it can be retried", () => {
    // `docker run` pulls implicitly and cannot be retried without also
    // re-creating the container, which is why the two are separate.
    expect(pgStep, "the image is no longer pulled before `docker run`").toContain("docker pull");
  });

  test("it retries more than once, with a growing delay", () => {
    const body = pgStep;
    const loop = /for attempt in ([^\n]+); do/.exec(body);
    expect(loop, "the pull is not wrapped in an attempt loop").not.toBeNull();
    const attempts = (loop?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    expect(
      attempts.length,
      "one attempt is not a retry — a rate limit needs a second request",
    ).toBeGreaterThan(1);
    // Backoff, not a fixed delay: the quota is per unit TIME, so equal short
    // waits spend the same exhausted budget again.
    expect(body, "the delay no longer grows between attempts").toMatch(
      /delay=\$\(\(delay \* \d+\)\)/,
    );
  });

  test("a non-transient failure is NOT retried", () => {
    const body = pgStep;
    // A wrong tag must stay fast and loud. Blanket retries would spend the whole
    // backoff in front of an error nobody reads — the same argument as the
    // extension check in that step.
    expect(body, "the retry no longer classifies the failure text").toContain("toomanyrequests");
    expect(body, "a non-transient pull failure is retried instead of failing fast").toMatch(
      /NON-transient|not retrying/,
    );
  });

  test("a SUCCESSFUL pull reports which attempt it took", () => {
    // The output is captured so it can be classified, so a green log says
    // nothing on its own — and the attempt count is the only evidence that
    // throttling is getting worse, on the step whose reason for existing is
    // throttling. Silence on the happy path is the wrong silence here.
    expect(pgStep, "a successful pull no longer reports its attempt number").toMatch(
      /succeeded on attempt \$\{attempt\}/,
    );
  });

  test("exhausting the retries FAILS the job", () => {
    // The trap this guards is a loop that falls out and carries on, leaving
    // `docker run` to fail later with an error naming the container rather than
    // the pull — or worse, a suite that skips itself.
    expect(pgStep, "a pull that never succeeded no longer exits non-zero").toMatch(
      /pulled:-0.*\n?[\s\S]{0,200}?exit 1/,
    );
  });
});
