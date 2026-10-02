// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `check:agent-guide` covers the guide as a SET of files, and the subpath list
 * it generates cannot drift from the `exports` map.
 *
 * `scripts/sync-agent-guide.mjs` copies the scaffold's core guide and every
 * `agent-guide/` topic file into the SDK tarball, and writes the
 * `@alexkroman1/aai` subpath list into the core and into the shipped skill from
 * `SUBPATHS` (`scripts/_agent-guide.mjs`). Its `--check` is green on a clean
 * tree, which cannot show it would go red, so this suite reads the same tree
 * independently: the committed copies match their sources, the routing table
 * names every topic, the record covers the exports map, and the budgets exist.
 */

import { describe, expect, test } from "vitest";
import { byCodeUnit, GATE_WIRING, numericConstant, repoPathOf, sole } from "./_gate-support.ts";

const moduleSource =
  sole(
    import.meta.glob<string>("../../../scripts/_agent-guide.mjs", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";
const core =
  sole(
    import.meta.glob<string>("../../aai-templates/scaffold/CLAUDE.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";
const coreCopy =
  sole(
    import.meta.glob<string>("../../aai/AGENT_GUIDE.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";
const skill =
  sole(
    import.meta.glob<string>("../../aai/skills/aai/SKILL.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "";
const manifest =
  sole(
    import.meta.glob<string>("../../aai/package.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ) ?? "{}";

const byName = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([key, text]) => [repoPathOf(key).split("/").pop() ?? key, text]),
  );
const topics = byName(
  import.meta.glob<string>("../../aai-templates/scaffold/agent-guide/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);
const topicCopies = byName(
  import.meta.glob<string>("../../aai/agent-guide/*.md", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** A copy is its source behind a generated banner comment. */
const bodyOf = (copy: string) => copy.replace(/^<!--[\s\S]*?-->\n\n?/, "");

const BEGIN = "<!-- BEGIN GENERATED aai subpaths";
const END = "<!-- END GENERATED aai subpaths -->";

describe("check:agent-guide", () => {
  test("is wired into both runners", () => {
    for (const [file, source] of Object.entries(GATE_WIRING)) {
      expect.soft(source, `${file} did not resolve`).toBeTypeOf("string");
      expect.soft(source, `${file} does not run check:agent-guide`).toContain("check:agent-guide");
    }
  });

  test("every topic file has a committed copy, and nothing else does", () => {
    const names = Object.keys(topics).sort(byCodeUnit);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(topicCopies).sort(byCodeUnit)).toEqual(names);
    for (const name of names) {
      expect
        .soft(bodyOf(topicCopies[name] ?? ""), `agent-guide/${name} copy is stale`)
        .toBe(topics[name]);
    }
    expect(bodyOf(coreCopy), "AGENT_GUIDE.md is stale").toBe(core);
  });

  test("the core's routing table names every topic file", () => {
    for (const name of Object.keys(topics)) {
      expect
        .soft(core, `the core never routes to agent-guide/${name}`)
        .toContain(`agent-guide/${name}`);
    }
  });

  test("the generated block is present in the core and the skill", () => {
    for (const [file, text] of [
      ["scaffold/CLAUDE.md", core],
      ["skills/aai/SKILL.md", skill],
    ] as const) {
      expect.soft(text, `${file} lost its BEGIN marker`).toContain(BEGIN);
      expect.soft(text, `${file} lost its END marker`).toContain(END);
    }
    // The bug this replaced: a hand-kept list naming a subpath that was gone.
    expect(skill).not.toContain("`/runtime`");
  });

  test("SUBPATHS covers the exports map exactly", () => {
    const block = /export const SUBPATHS = \{([\s\S]*?)\n\};/.exec(moduleSource)?.[1] ?? "";
    const described = [...block.matchAll(/^ {2}"(\.[^"]*)": \{/gm)]
      .map((match) => match[1] ?? "")
      .sort(byCodeUnit);
    const exported = Object.keys(
      (JSON.parse(manifest) as { exports?: Record<string, unknown> }).exports ?? {},
    ).sort(byCodeUnit);
    expect(exported.length).toBeGreaterThan(10);
    expect(described).toEqual(exported);
  });

  test("the budgets are declared, and the core sits under its own", () => {
    const budget = (name: string) =>
      numericConstant(moduleSource, name, "scripts/_agent-guide.mjs");
    const coreBudget = budget("CORE_BUDGET");
    const topicBudget = budget("TOPIC_BUDGET");
    expect(coreBudget).toBeGreaterThan(0);
    expect(coreBudget).toBeLessThan(topicBudget);
    expect(core.length).toBeLessThanOrEqual(coreBudget);
    for (const [name, text] of Object.entries(topics)) {
      expect
        .soft(text.length, `agent-guide/${name} is over TOPIC_BUDGET`)
        .toBeLessThanOrEqual(topicBudget);
    }
  });
});
