// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Rule 20's own spec — the changeset scanner, split out of
 * `guard-invariants-gate.test.ts`.
 *
 * The seam is by SUBJECT rather than by size, which is what the 700-line test
 * cap is there to force: everything in the sibling file is about a RULE'S
 * PATTERN (does it match, does it spare, is it sampled at all), and everything
 * here is about one scanner's parse of a `.changeset/*.md` file. They share
 * nothing but `sole` and the gate's source text.
 *
 * Rule 20 is a SCANNER, not a baselined pattern, so that file's sample table
 * cannot reach it — and a scanner is where the silent-blindness failure is
 * worst: it reads the real tree, and a healthy tree is exactly a tree with
 * nothing to find. Its whole success output is `0 ✓`, which is also what a
 * scanner that had stopped parsing frontmatter, or stopped finding
 * `.changeset/*.md`, would print.
 *
 * So the per-file half is split out as `checkChangeset(file, source, known)`
 * and driven here with real samples. Rule 20's own subject is a gate that
 * reports success over a mistake — `pnpm changeset status` exits 0 on a typo'd
 * package name — so shipping it with a spec that could do the same would be
 * the joke writing itself.
 */

import { describe, expect, test } from "vitest";
import { sole } from "./_gate-support.ts";

const script = sole(
  import.meta.glob("../../../scripts/guard-invariants.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const changesets = sole(
  import.meta.glob<{
    checkChangeset: (
      file: string,
      source: string,
      known: Set<string>,
    ) => { file: string; line: number; text: string }[];
    checkChangesetConsumable: (
      file: string,
      source: string,
      versionable: Set<string>,
    ) => { file: string; line: number; text: string }[];
    checkChangesetShippable: (
      file: string,
      source: string,
    ) => { file: string; line: number; text: string }[];
    workspacePackageNames: () => Set<string>;
    versionablePackageNames: () => Set<string>;
  }>("../../../scripts/guard-invariants-changesets.mjs", { eager: true }),
);

describe("guard-invariants rule 20 (changeset package names)", () => {
  const known = new Set(["@alexkroman1/aai", "aai-server"]);
  const check = (source: string) => changesets?.checkChangeset("c.md", source, known) ?? [];

  test.each([
    ["a package that does not exist", '---\n"@alexkroman1/aai-typo": patch\n---\n\nx\n'],
    ["a bump type that does not exist", '---\n"@alexkroman1/aai": pathc\n---\n\nx\n'],
    ["an unquoted unknown package", "---\naai-servr: patch\n---\n\nx\n"],
    ["no frontmatter at all", "just a summary\n"],
    ["frontmatter that never closes", '---\n"@alexkroman1/aai": patch\n\nx\n'],
  ])("flags %s", (_label, source) => {
    expect(check(source).length, "rule 20 found nothing in a bad changeset").toBeGreaterThan(0);
  });

  test.each([
    ["a valid single-package changeset", '---\n"@alexkroman1/aai": patch\n---\n\nx\n'],
    ["a private workspace package", '---\n"aai-server": minor\n---\n\nx\n'],
    ["an unquoted valid package", "---\naai-server: major\n---\n\nx\n"],
    // `pnpm changeset add --empty` is the documented way to say "no release".
    ["an empty frontmatter block", "---\n---\n\n"],
  ])("spares %s", (_label, source) => {
    expect(check(source), "rule 20 flagged a legitimate changeset").toEqual([]);
  });

  test("the workspace-name corpus is floored", () => {
    // Every name is checked by MEMBERSHIP in this set, so a derivation that has
    // gone blind must throw rather than let the comparison run against nothing.
    const names = changesets?.workspacePackageNames() ?? new Set();
    expect(names.size, "too few workspace packages discovered").toBeGreaterThanOrEqual(9);
    expect(names, "the SDK is not among the discovered packages").toContain("@alexkroman1/aai");
  });

  test("the rule is wired into the gate", () => {
    expect(script).toContain("scanChangesetPackageNames");
  });

  /**
   * The second half of rule 20: a changeset that names real packages and STILL
   * cannot move any of them. It wedges the release pipeline permanently and,
   * because the action only publishes when nothing is pending, stops publishing
   * altogether — which took production down, since the guest image installs the
   * SDK from npm at the version this repo declares.
   *
   * Driven with an explicit `versionable` set rather than the real config, so the
   * samples keep asserting the same thing after somebody flips
   * `privatePackages.version`.
   */
  describe("consumability", () => {
    // What it looks like with `privatePackages.version` off: the private ones
    // are real packages and are not versionable.
    const versionable = new Set(["@alexkroman1/aai"]);
    const consumable = (source: string) =>
      changesets?.checkChangesetConsumable("c.md", source, versionable) ?? [];

    test.each([
      ["only a non-versionable package", '---\n"aai-server": patch\n---\n\nx\n'],
      ["several, none versionable", '---\n"aai-server": patch\n"aai-guest": patch\n---\n\nx\n'],
    ])("flags a changeset naming %s", (_label, source) => {
      expect(consumable(source).length, "an inert changeset was not flagged").toBeGreaterThan(0);
      expect(consumable(source)[0]?.text).toContain("never be consumed");
    });

    test.each([
      ["a versionable package", '---\n"@alexkroman1/aai": patch\n---\n\nx\n'],
      [
        "a mix, at least one versionable",
        '---\n"@alexkroman1/aai": patch\n"aai-server": patch\n---\n\nx\n',
      ],
      // `--empty` names nothing, is consumed, and bumps nothing by design.
      ["nothing at all (--empty)", "---\n---\n\n"],
      // A malformed changeset is checkChangeset's finding; reporting it twice
      // would make one mistake look like two.
      ["malformed frontmatter", "no frontmatter here\n"],
    ])("spares a changeset naming %s", (_label, source) => {
      expect(consumable(source), "a legitimate changeset was flagged").toEqual([]);
    });

    describe("a bump that ships nowhere", () => {
      /**
       * The THIRD flavour of inert release metadata, and the one every other
       * gate passes. `aai-studio-client`, `aai-guest` and `aai-templates` are
       * each built into another package's artifact, so bumping one alone writes
       * a version and a CHANGELOG entry and delivers nothing — while the
       * pre-push `changeset status` is satisfied, because it only asks whether
       * the changed packages have A changeset. An author who changes the studio
       * front-end, is correctly told to write a changeset, and names the package
       * they changed has cleared every check and deployed nothing.
       */
      const shippable = (source: string) =>
        changesets?.checkChangesetShippable("c.md", source) ?? [];

      test.each([
        ["aai-studio-client alone", '---\n"aai-studio-client": patch\n---\n\nx\n'],
        ["aai-guest alone", '---\n"aai-guest": patch\n---\n\nx\n'],
        ["aai-templates alone", '---\n"aai-templates": patch\n---\n\nx\n'],
        [
          "a built-in package beside a NON-carrier",
          '---\n"aai-studio-client": patch\n"aai-evals": patch\n---\n\nx\n',
        ],
      ])("flags a changeset naming %s", (_label, source) => {
        expect(
          shippable(source).length,
          "a bump that ships nowhere was not flagged",
        ).toBeGreaterThan(0);
      });

      test.each([
        [
          "aai-studio-client with the studio server",
          '---\n"aai-studio-client": patch\n"aai-studio-server": patch\n---\n\nx\n',
        ],
        [
          "aai-guest with the platform server",
          '---\n"aai-guest": patch\n"aai-server": patch\n---\n\nx\n',
        ],
        [
          "aai-templates with a fixed-group member",
          '---\n"aai-templates": patch\n"@alexkroman1/aai-cli": patch\n---\n\nx\n',
        ],
        // A package with its own ship path is not this rule's business.
        ["only the platform server", '---\n"aai-server": patch\n---\n\nx\n'],
        ["nothing at all (--empty)", "---\n---\n\n"],
        ["malformed frontmatter", "no frontmatter here\n"],
      ])("spares a changeset naming %s", (_label, source) => {
        expect(shippable(source), "a legitimate changeset was flagged").toEqual([]);
      });

      test("every package the table names still exists in the workspace", () => {
        // The table matches by NAME, so a rename would make it match nothing and
        // report `0 ✓` over the hole it exists to close. The scan asserts this
        // too; pinning it here is what makes a rename fail in the ordinary test
        // run rather than only under `pnpm check`.
        const known = changesets?.workspacePackageNames() ?? new Set<string>();
        for (const name of [
          "aai-studio-client",
          "aai-guest",
          "aai-templates",
          "aai-server",
          "aai-studio-server",
          "@alexkroman1/aai-cli",
        ]) {
          expect(known, `${name} is no longer a workspace package`).toContain(name);
        }
      });
    });

    test("the real config versions private packages, so nothing in the tree is inert", () => {
      // The fix for the incident, asserted as a property rather than trusted:
      // this repo writes changesets for its private packages (aai-server,
      // aai-studio-server, aai-guest…), so versioning them is what keeps those
      // changesets consumable.
      const real = changesets?.versionablePackageNames() ?? new Set<string>();
      expect(real, "the SDK is not versionable").toContain("@alexkroman1/aai");
      expect(
        real,
        "private packages are not versionable — changesets naming them would wedge the release",
      ).toContain("aai-server");
    });
  });
});
