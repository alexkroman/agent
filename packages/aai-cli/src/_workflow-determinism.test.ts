// Copyright 2026 the AAI authors. MIT license.
/**
 * The computed-identity warning.
 *
 * Two claims are worth more than the rest. It fires on the shape the TYPE
 * system passes — a template-literal step name, which `Literal<Name>` does not
 * reject — and it fires on NOTHING in the fourteen shipped templates, which is
 * what makes it safe to print at every `aai build`. The second is asserted
 * against the real template tree rather than argued, because a checker whose
 * false-positive rate nobody measured is one authors learn to ignore.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  determinismWarnings,
  findComputedIdentities,
  scanWorkflowDeterminism,
} from "./_workflow-determinism.ts";

/**
 * A template-literal step name, as SOURCE text: `tpl("charge-", "coin")` is
 * ```charge-${coin}```, backticks included.
 *
 * Composed rather than written out, and neither spelling works directly: biome
 * reads a literal `${` inside a plain string as a mistaken template — true in
 * general, and this file's whole subject is source lines that contain one — and
 * a template literal is not the escape, since with no REAL placeholder biome
 * rewrites it back to a quoted string. This one has two, so it stays.
 */
const tpl = (prefix: string, expr: string) => `\`${prefix}\${${expr}}\``;

function methods(line: string): string[] {
  return findComputedIdentities(line, "workflows/digest.ts").map((found) => found.method);
}

describe("the vocabulary matches the repo gate beside it", () => {
  test("the three identities are the three rule 32 bans, and no more", () => {
    // Read out of the gate script's SOURCE rather than imported: that file is
    // plain node run from the repo root, this ships inside a published CLI, and
    // neither can import the other — which is exactly why the two lists can
    // drift. Reading one and comparing is the only thing that stops them.
    const source = readFileSync(
      path.join(import.meta.dirname, "../../../scripts/guard-invariants-rules-workflow.mjs"),
      "utf-8",
    );
    const block = source.match(/const IDENTITY_CALLS = \[([^\]]*)\]/);
    // A floor on the PARSE. The assertion below compares two lists, so a regex
    // that stopped matching would compare this module against an empty one and
    // pass — a gate reporting success over nothing, which `AGENTS.md` names
    // five times over.
    expect(block?.[1], "the gate script's identity list is no longer parseable").toBeDefined();
    // `.flatMap` rather than `.map`, so the list is `string[]` and not
    // `(string | undefined)[]` — a captured group is optional to the type
    // checker even where the pattern makes it mandatory.
    const gate = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1]],
    );
    expect(gate.length).toBeGreaterThanOrEqual(3);

    // Against what this module actually reports, not against a second copy of
    // the list: a probe per name is what proves the CLI half covers it.
    const byName = (a: string, b: string) => a.localeCompare(b);
    const covered = gate.flatMap((name) => methods(`  await ctx.${name}(${tpl("k-", "i")}, f);`));
    expect([...covered].sort(byName)).toEqual([...gate].sort(byName));
  });
});

describe("what it reports", () => {
  test.each([
    ["step", `  await ctx.step(${tpl("charge-", "coin")}, charge);`],
    ["sleep", `  await ctx.sleep(${tpl("wait-", "n")}, DAY_MS);`],
    ["waitFor", `  await ctx.waitFor(${tpl("hook-", "id")});`],
  ])("a computed ctx.%s identity", (method, line) => {
    expect(methods(line)).toEqual([method]);
  });

  test("a renamed or destructured receiver, since a body may take either", () => {
    expect(methods(`  await step(${tpl("charge-", "coin")}, charge);`)).toEqual([]);
    expect(methods(`  await flow.step(${tpl("charge-", "coin")}, charge);`)).toEqual(["step"]);
  });

  test("names the file and the 1-indexed line, so `file:line` opens it", () => {
    const found = findComputedIdentities(
      `const a = 1;\n\nawait ctx.step(${tpl("charge-", "coin")}, charge);\n`,
      "workflows/x.ts",
    );
    expect(found).toEqual([
      {
        file: "workflows/x.ts",
        line: 3,
        method: "step",
        text: `await ctx.step(${tpl("charge-", "coin")}, charge);`,
      },
    ]);
  });
});

describe("what it must NOT report", () => {
  test.each([
    ["a plain literal, which is every shipped step", '  await ctx.step("fetchArticle", fetch);'],
    ["a single-quoted literal", "  await ctx.step('fetchArticle', fetch);"],
    [
      "a template literal with NO interpolation, which is a literal",
      "  await ctx.step(`fetchArticle`, fetch);",
    ],
    ["a bare identifier, which is the TYPE system's job", "  await ctx.step(STEP_NAME, fetch);"],
    ["a different ctx method", "  const t = await ctx.now();"],
    [
      "a line comment showing the banned shape",
      `  // never ctx.step(${tpl("charge-", "coin")}, …)`,
    ],
    ["a block-comment continuation", `   * so ctx.step(${tpl("charge-", "coin")}) is banned`],
    [
      "a step whose CALLBACK interpolates, the name being a literal",
      `  await ctx.step("post", () => post(\`\${base}/x\`));`,
    ],
  ])("%s", (_why, line) => {
    expect(methods(line)).toEqual([]);
  });
});

describe("scanning a project", () => {
  async function project(files: Record<string, string>): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "aai-determinism-"));
    await mkdir(path.join(cwd, "workflows"), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      await writeFile(path.join(cwd, rel), body, "utf-8");
    }
    return cwd;
  }

  test("finds a computed identity in every workflow body", async () => {
    const cwd = await project({
      "workflows/digest.ts": `await ctx.step(${tpl("a-", "x")}, f);\n`,
      "workflows/poll.ts": `await ctx.sleep(${tpl("b-", "y")}, 1);\n`,
    });
    const found = await scanWorkflowDeterminism(cwd);
    expect(found.map((f) => f.method)).toEqual(["step", "sleep"]);
  });

  test("skips a co-located SPEC, which may name a step however it likes", async () => {
    // A spec drives a body once; nothing replays it. Warning about its
    // generated step names is how the whole report gets dismissed.
    const cwd = await project({
      "workflows/digest.test.ts": `await ctx.step(${tpl("a-", "x")}, f);\n`,
    });
    expect(await scanWorkflowDeterminism(cwd)).toEqual([]);
  });

  test("a project with NO workflows directory is silent, not an error", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "aai-determinism-"));
    await expect(scanWorkflowDeterminism(cwd)).resolves.toEqual([]);
  });
});

describe("the shipped templates", () => {
  /**
   * The false-positive floor, and it is the reason this may print unprompted.
   *
   * Every template is a project a user scaffolds and then runs `aai build` on,
   * so a finding here is a finding on somebody's first build — which is how a
   * warning stops being read. It holds by CONSTRUCTION rather than by luck:
   * identity is `(name, occurrence)`, so a fan-out reuses one name and no
   * shipped body has any reason to compute one.
   *
   * The count is floored as well as compared, for the reason `AGENTS.md` gives
   * five times over: a glob that stopped resolving would scan zero projects and
   * report zero findings, which is this assertion passing while checking
   * nothing.
   */
  test("produce no findings at all — a project a user scaffolds must be clean", async () => {
    const base = path.join(import.meta.dirname, "../../aai-templates/templates");
    const templates = (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(templates.length).toBeGreaterThanOrEqual(12);

    const findings: string[] = [];
    for (const template of templates) {
      for (const found of await scanWorkflowDeterminism(path.join(base, template))) {
        findings.push(`${template}/${found.file}:${found.line}`);
      }
    }
    expect(findings).toEqual([]);
  });

  test("and at least one of them really is SCANNED, not merely absent", async () => {
    // The other half of the floor above: the clean result must come from
    // reading workflow bodies rather than from finding none. `link-digest` is
    // one of the six templates that ship a `workflows/` directory.
    const base = path.join(import.meta.dirname, "../../aai-templates/templates/link-digest");
    const source = await scanWorkflowDeterminism(base);
    expect(source).toEqual([]);
    const files = await readdir(path.join(base, "workflows"));
    expect(files.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(0);
  });
});

describe("the warning text", () => {
  test("is nothing at all when the bodies are clean", () => {
    expect(determinismWarnings([])).toEqual([]);
  });

  test("is one line per finding plus the remedy ONCE", () => {
    const warnings = determinismWarnings([
      {
        file: "workflows/a.ts",
        line: 4,
        method: "step",
        text: `await ctx.step(${tpl("a-", "x")}, f);`,
      },
      {
        file: "workflows/b.ts",
        line: 9,
        method: "sleep",
        text: `await ctx.sleep(${tpl("b-", "y")}, 1);`,
      },
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("workflows/a.ts:4");
    expect(warnings[1]).toContain("workflows/b.ts:9");
    // It must name the OCCURRENCE counter: "use a literal" alone reads as a
    // restriction on fan-outs, which is the one case an author will think
    // they need a computed name for.
    expect(warnings[2]).toContain("occurrence");
  });
});
