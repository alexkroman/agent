// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The ORDERING in `.github/workflows/ship.yml`, which used to be three
 * workflows and two polling scripts.
 *
 * The two gate specs this file replaces (`npm-wait-gate.test.ts`,
 * `guest-image-wait-gate.test.ts`) each guarded a waiter that stood in for a
 * dependency GitHub Actions could not express across workflows. Both waiters
 * are deleted, so what needs guarding is no longer a poll loop or a packument
 * shape — it is the `needs:` edges themselves, plus the two places the release's
 * packed tarballs are handed along. Every one of them is a single line that can
 * be dropped in an edit while the workflow still parses, still runs, and still
 * goes green over the failure it was there to stop.
 *
 * The edge that matters most is `deploy` → `guest-image`. Without it a red
 * image build cannot fail a deploy, and that is not hypothetical: over the 25
 * pushes before this change the publisher failed four times, and the Version
 * Packages push on 2026-08-31 shipped a real 665s rollout beside a red image
 * build. The deploy was green, and every sandbox spawn then 404'd on the pull,
 * because the image is fetched at SPAWN time and not at deploy time.
 *
 * Deploy runs on no pull request, so nothing else reads this wiring before
 * production does. It lives in aai-templates because this package already owns
 * the tests for repo-level scripts and workflow wiring, and reaches them with
 * raw/eager imports.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

const workflow = sole(
  import.meta.glob<string>("../../.github/workflows/ship.yml", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/**
 * The `needs:` list declared by one job.
 *
 * Deliberately not a YAML parser — this package carries none, for the reason
 * `ci-gate-job.test.ts` gives. Four facts are read out of the file, and a
 * malformed one fails the shape assertions below anyway.
 */
function needsOf(source: string, job: string): string[] {
  const block = source.slice(source.indexOf(`\n  ${job}:\n`));
  const match = /\n {4}needs: (.+)\n/.exec(block.slice(0, block.indexOf("\n    steps:")));
  const declared = match?.[1];
  if (declared === undefined) return [];
  return declared
    .replace(/[[\]]/g, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

describe("the ordering is declared, not polled", () => {
  test("deploy waits on the guest image, the release and the migration", () => {
    expect(workflow).toBeTypeOf("string");
    const needs = needsOf(workflow ?? "", "deploy");
    // guest-image is the edge whose absence let four green deploys ride over a
    // red image build; the other three are the stages a rollout stands on.
    expect(needs).toContain("guest-image");
    expect(needs).toContain("release");
    expect(needs).toContain("migrate");
    expect(needs).toContain("changed");
  });

  test("the guest image waits on the release that packs its SDK", () => {
    expect(needsOf(workflow ?? "", "guest-image")).toContain("release");
  });

  test("deploy's condition never accepts a skipped or failed dependency", () => {
    // `always()` would re-open the hole this file exists to close: it makes a
    // job run despite a failed `needs:`, which is exactly how a deploy shipped
    // over a red image build before. A plain `if:` on an output is the whole
    // point — GitHub skips the job when any dependency fails.
    expect(workflow).not.toMatch(/always\(\)/);
  });

  test("the Version Packages PR blocks nothing", () => {
    const source = workflow ?? "";
    // Opening a PR for humans and shipping the code have different failure
    // modes, and this step has wedged the whole line before (#1131: an empty
    // `changeset-release/main` and "No commits between main and
    // changeset-release/main"). Nothing may depend on it, so a broken PR step
    // costs a PR and not a release.
    for (const job of ["release", "guest-image", "deploy", "changed", "migrate"]) {
      expect(needsOf(source, job), `${job} must not depend on version-pr`).not.toContain(
        "version-pr",
      );
    }
    // And the action must live there rather than in the shipping line.
    const action = source.slice(source.indexOf("changesets/action@"));
    expect(source.indexOf("version-pr:")).toBeLessThan(source.indexOf("changesets/action@"));
    expect(action.indexOf("release:")).toBeGreaterThan(0);
  });

  test("no deleted waiter is still invoked", () => {
    // The INVOCATION, not the name: this workflow's header explains at length
    // why both scripts were deleted, and a rule that could not tell a `run:`
    // from the prose about it would make the explanation unwriteable.
    expect(workflow).not.toMatch(/node scripts\/wait-for-/);
  });
});

describe("what arms a deploy", () => {
  /**
   * The `changed` job's `diff` step, which is the whole decision.
   *
   * The STEP, not the job — the header comment above it argues at length about
   * the source-path arm and names the very globs the assertion below forbids,
   * which is the comment-versus-condition problem this file already works
   * around for the deleted waiters. Every caller therefore asserts something
   * PRESENT as well, since an empty slice satisfies a `not.toContain` for free.
   */
  function diffStep(): string {
    const source = workflow ?? "";
    const diff = source.slice(source.indexOf("      - id: diff"));
    return diff.slice(0, diff.indexOf('$GITHUB_OUTPUT"\n\n'));
  }

  /**
   * A version bump is what ships the platform, and BOTH server packages count.
   * There is one Modal app serving both surfaces from the aai-studio-server
   * entry, so gating on `aai-server` alone strands every studio-only release.
   */
  test("a version bump to either server package arms the deploy", () => {
    const step = diffStep();
    expect(step).toContain("deploy=false");
    expect(step).toContain("bumped aai-server");
    expect(step).toContain("bumped aai-studio-server");
  });

  /**
   * #1343 armed the deploy off a source diff over `packages/aai-server/**` and
   * `packages/aai-studio-server/**`, and it is reverted: it made a production
   * rollout the consequence of a MERGE rather than of a RELEASE, so every
   * server PR deployed on its own, several times a day, with no release to
   * name. The remedy is a changeset naming a server package — which is the
   * model `guard-invariants` rule 20's `SHIPS_VIA` table is already built on,
   * and why an `aai-studio-client` or `aai-guest` change must name a carrier.
   *
   * Asserted because the symptom it was written for is real and documented, so
   * the arm is the first thing a reader of that history re-adds.
   */
  test("a server SOURCE change alone does not arm the deploy", () => {
    const step = diffStep();
    expect(step, "the diff step no longer slices out — the shape of this job moved").toContain(
      "deploy=false",
    );
    for (const glob of ["packages/aai-server/**", "packages/aai-studio-server/**"]) {
      expect(
        step,
        `${glob} arms a deploy, so every server merge ships instead of every release`,
      ).not.toContain(glob);
    }
  });

  /**
   * `deploy` declares `needs: [changed, migrate, …]` with no `always()`, so a
   * SKIPPED migrate skips the deploy however `outputs.deploy` reads. Every
   * branch that sets `deploy=true` therefore has to set `migrate=true` too, or
   * it is a silent no-op. Asserted by counting, because the failure is an
   * ABSENT line rather than a wrong one.
   */
  test("every branch that arms a deploy also arms the migration", () => {
    const step = diffStep();
    const arms = step.match(/^ *deploy=true$/gm) ?? [];
    const migrates = step.match(/^ *migrate=true$/gm) ?? [];
    expect(arms.length, "no branch arms a deploy — the scan has stopped matching").toBeGreaterThan(
      0,
    );
    expect(
      migrates.length,
      "a branch arms deploy without migrate, which `needs: migrate` turns into a no-op",
    ).toBeGreaterThanOrEqual(arms.length);
  });
});

describe("the packed release reaches the image", () => {
  test("pack, publish and the image build all name the same directory", () => {
    const source = workflow ?? "";
    // One directory, three consumers: `changeset pack` writes it, `changeset
    // publish` uploads from it, and the image installs from it. Two of the
    // three agreeing is a release whose image holds different bytes than npm.
    expect(source).toContain("changeset pack --out-dir .changeset-pack");
    expect(source).toContain("changeset publish --from-pack-dir .changeset-pack");
    expect(source).toContain("--sdk-pack-dir .changeset-pack");
  });

  test("the pack directory is uploaded despite being hidden", () => {
    const source = workflow ?? "";
    // The directory those three consumers agree on is DOT-PREFIXED, and since
    // upload-artifact v4.4 that makes it hidden and excluded by default. The
    // hand-off then fails in the one way this file exists to catch: the pack
    // step prints its four tarballs, the upload one line later reports "No
    // files were found", and `if-no-files-found: error` takes the publish, the
    // tags, the image and the deploy down with it (run 33410419652). Asserted
    // against the upload step rather than the file, so a second artifact
    // elsewhere cannot satisfy it.
    const upload = source.slice(source.indexOf("name: Upload the packed release"));
    const step = upload.slice(0, upload.indexOf("      - name:"));
    expect(step).toContain("path: .changeset-pack");
    expect(step).toContain("include-hidden-files: true");
  });

  test("pack and publish sit outside the changesets action", () => {
    const source = workflow ?? "";
    // `changesets/action` only invokes its own `publish:` when there are NO
    // pending changesets, so a version bump landing while changesets are queued
    // is never published — the 6.1.0 failure. The action must therefore carry
    // `version:` and nothing else.
    const action = source.slice(source.indexOf("changesets/action@"));
    const step = action.slice(0, action.indexOf("      - run:"));
    expect(step).toContain("version: pnpm run version");
    expect(step).not.toContain("publish:");
  });

  test("the release tags are pushed, not merely created", () => {
    const source = workflow ?? "";
    // `changeset publish` calls `git tag` and stops there — pushing them was the
    // changesets action's job, and the action no longer runs the publish. Drop
    // this step and the versions still reach npm while every release tag names
    // no commit, which nothing notices until somebody goes looking for one.
    expect(source).toContain("git push --tags");
  });

  test("the image build is told whether a release was packed", () => {
    const source = workflow ?? "";
    // Passing `--sdk-pack-dir` unconditionally would fail every ordinary push,
    // because `stageSdkPackDir` refuses an absent or stale directory by design.
    // The expression body only: an assertion carrying the whole `${{ … }}`
    // wrapper reads to Biome as a template placeholder, and the wrapper is not
    // the part that can be wrong.
    expect(source).toContain("packed: ");
    expect(source).toContain("steps.pack.outputs.packed");
    expect(source).toContain("needs.release.outputs.packed == 'true'");
  });
});

describe("a rollback can name its commit", () => {
  test("every checkout honours the ref input", () => {
    const source = workflow ?? "";
    const checkouts = source.match(/uses: actions\/checkout@/g) ?? [];
    const refs = source.match(/ref: \$\{\{ inputs\.ref \|\| github\.ref \}\}/g) ?? [];
    // A checkout that ignored the input would ship main's head under a rollback
    // dispatch — the one outcome a rollback must never produce. There are as
    // many honouring checkouts as there are checkouts.
    expect(checkouts.length).toBeGreaterThan(0);
    expect(refs).toHaveLength(checkouts.length);
  });
});

describe("the rollout is observed, not only predicted", () => {
  test("deploy verifies the rollout and then spawns a real sandbox", () => {
    const source = workflow ?? "";
    expect(source).toContain("verify_modal_deploy.py");
    expect(source).toContain("scripts/smoke-spawn.mjs");
    // Ordered: the spawn is meaningless against a rollout that never started,
    // and its failure message assumes a serving platform.
    expect(source.indexOf("verify_modal_deploy.py")).toBeLessThan(
      source.indexOf("scripts/smoke-spawn.mjs"),
    );
  });
});
