// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The shared readings, over samples rather than over the repo.
 *
 * Every other spec here asserts a GATE. This one asserts the vocabulary they
 * all read the repo through — and it exists because that vocabulary grew a
 * failure mode of its own: four of these helpers THROW when what they are
 * looking for is gone, and every argument for them turns on that throw.
 * `numericConstant`'s doc says a reader answering `NaN` "would turn a renamed
 * constant into a comparison nobody can fail"; `workflowJobs.body` throws
 * because `ship.yml`'s old reader failed OPEN, answering `[]` for a job it
 * could not find and so satisfying every `not.toContain` a caller made of it.
 *
 * None of those paths is reachable from a healthy tree, which is exactly why
 * they need samples: a defensive branch nothing exercises is indistinguishable
 * from one that was never written, and this package's whole subject is guards
 * that pass while checking nothing.
 *
 * Samples, not repo reads — this is the one file here with no gate of its own.
 */

import { describe, expect, test } from "vitest";
import {
  bracketList,
  byCodeUnit,
  numericConstant,
  packageDirOf,
  repoPathOf,
  sole,
  withoutYamlComments,
  workflowJobs,
} from "./_gate-support.ts";

/** A workflow with three jobs, the last one deliberately last. */
const WORKFLOW = [
  "name: check",
  "on:",
  "  push:",
  "    branches: [main]",
  "concurrency:",
  "  group: check-main",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pnpm lint",
  "  test:",
  "    needs: [lint]",
  "    # a comment naming deploy, which is not a dependency",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: pnpm test",
  "  deploy:",
  "    needs: lint, test",
  "    if: github.ref == 'refs/heads/main'",
  "    steps:",
  "      - run: echo ship",
].join("\n");

describe("workflowJobs", () => {
  const jobs = workflowJobs(WORKFLOW, "sample.yml");

  test("names every job, in declaration order", () => {
    expect(jobs.names()).toEqual(["lint", "test", "deploy"]);
  });

  test("the header is everything above `jobs:`", () => {
    expect(jobs.header()).toContain("concurrency:");
    expect(jobs.header(), "the header reached into the jobs block").not.toContain("runs-on");
  });

  test("a job body stops at the next job KEY, not at the next job's NAME", () => {
    // The property the old `indexOf("\n  deploy:")` slices could not give: this
    // holds whatever the following job is called, and a job inserted between
    // the two does not widen the answer.
    expect(jobs.body("test")).toContain("pnpm test");
    expect(jobs.body("test"), "the slice ran into the following job").not.toContain("echo ship");
  });

  test("the LAST job runs to end of file", () => {
    expect(jobs.body("deploy")).toContain("echo ship");
  });

  test("a job that is not in the file THROWS rather than answering empty", () => {
    // The whole point. An empty answer here satisfies every `not.toContain` a
    // caller makes, which is how a hardcoded job roster went vacuous.
    expect(() => jobs.body("nonexistent")).toThrow(/sample\.yml has no job named nonexistent/);
  });

  test("a file with no `jobs:` block THROWS on names and header", () => {
    const empty = workflowJobs("name: nothing\n", "empty.yml");
    expect(() => empty.names()).toThrow(/empty\.yml has no top-level `jobs:` block/);
    expect(() => empty.header()).toThrow(/empty\.yml has no top-level `jobs:` block/);
  });

  test("needs reads both the bracketed and the bare spelling", () => {
    expect(jobs.needs("test")).toEqual(["lint"]);
    expect(jobs.needs("deploy")).toEqual(["lint", "test"]);
  });

  test("a job declaring no `needs:` answers empty rather than throwing", () => {
    // Legitimate — the first job in a graph has none, and a caller iterating
    // every job asks this of all of them.
    expect(jobs.needs("lint")).toEqual([]);
  });

  test("field reads a scalar, and is absent rather than empty when undeclared", () => {
    expect(jobs.field("deploy", "if")).toBe("github.ref == 'refs/heads/main'");
    expect(jobs.field("lint", "if")).toBeUndefined();
  });
});

describe("withoutYamlComments", () => {
  test("drops whole-line comments at any indent", () => {
    const stripped = withoutYamlComments(WORKFLOW);
    expect(stripped, "a comment naming a job survived the strip").not.toContain("not a dependency");
    expect(stripped, "a real step was dropped with the prose").toContain("pnpm test");
  });

  test("spares a `#` that is not the first thing on its line", () => {
    expect(withoutYamlComments("  group: check-main # keep")).toContain("# keep");
  });
});

describe("bracketList", () => {
  test.each([
    ["[a, b]", ["a", "b"]],
    ["a, b", ["a", "b"]],
    ["[]", []],
    ["  spaced  ,  out  ", ["spaced", "out"]],
    [undefined, []],
  ])("%s", (declared, expected) => {
    expect(bracketList(declared)).toEqual(expected);
  });
});

describe("numericConstant", () => {
  test("reads an underscore-separated integer and a decimal", () => {
    expect(numericConstant("const MAX_CHARS = 120_000;", "MAX_CHARS", "x.mjs")).toBe(120_000);
    expect(numericConstant("const WARN_RATIO = 0.9;", "WARN_RATIO", "x.mjs")).toBe(0.9);
  });

  test("THROWS on a declaration that is gone, rather than answering NaN", () => {
    expect(() => numericConstant("const OTHER = 1;", "MAX_CHARS", "x.mjs")).toThrow(
      /x\.mjs no longer declares MAX_CHARS/,
    );
  });
});

describe("byCodeUnit", () => {
  test("orders by code unit and reports equality as 0", () => {
    expect(byCodeUnit("a", "b")).toBe(-1);
    expect(byCodeUnit("b", "a")).toBe(1);
    // The branch a hand-rolled `a < b ? -1 : 1` copy in `published-files-gate`
    // did not have, which made equal keys compare as `1`.
    expect(byCodeUnit("a", "a")).toBe(0);
  });

  test("uppercase sorts before lowercase, as a code-unit order must", () => {
    expect(["b", "A", "a"].sort(byCodeUnit)).toEqual(["A", "a", "b"]);
  });
});

describe("repoPathOf and packageDirOf", () => {
  test.each([
    ["../../aai/src/index.ts", "packages/aai/src/index.ts"],
    ["./_gate-support.ts", "packages/aai-gates/src/_gate-support.ts"],
    ["../../../AGENTS.md", "AGENTS.md"],
    ["../../../.github/workflows/ship.yml", ".github/workflows/ship.yml"],
  ])("%s resolves to %s", (key, expected) => {
    expect(repoPathOf(key)).toBe(expected);
  });

  test("packageDirOf names the workspace package, whatever prefix the key carries", () => {
    expect(packageDirOf("../../aai-cli/src/x.ts")).toBe("aai-cli");
    // The self entry, which Vite spells differently from a sibling's — the case
    // a prefix test on the raw key gets wrong, silently.
    expect(packageDirOf("./_gate-support.ts")).toBe("aai-gates");
  });

  test("a key outside packages/ has no package directory", () => {
    expect(packageDirOf("../../../AGENTS.md")).toBe("");
  });
});

describe("sole", () => {
  test("answers the one value of a single-entry glob result", () => {
    expect(sole({ "../../../AGENTS.md": "text" })).toBe("text");
  });

  test("answers undefined for a glob that resolved to nothing", () => {
    // Load-bearing: a source that stopped resolving must fail the caller's own
    // `toBeTypeOf("string")` rather than pass as an empty search.
    expect(sole({})).toBeUndefined();
  });
});
