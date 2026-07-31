// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { grepWorkspace, StudioGrepError } from "./studio-grep.ts";

const FILES = {
  "agent.ts":
    'import { tool } from "@alexkroman1/aai";\nconst rollDice = tool({});\nexport default {};\n',
  "shared.ts": "export type Pizza = { size: string };\n",
  "notes.md": "rollDice is the dice tool\n",
};

describe("grepWorkspace", () => {
  test("returns path:line: text for each match", () => {
    const out = grepWorkspace(FILES, "rollDice");
    expect(out).toContain("agent.ts:2: const rollDice = tool({});");
    expect(out).toContain("notes.md:1: rollDice is the dice tool");
  });

  test("reports no matches plainly", () => {
    expect(grepWorkspace(FILES, "nothingHere")).toBe("No matches found");
  });

  test("treats the pattern as a regex by default", () => {
    expect(grepWorkspace(FILES, "^export")).toContain("shared.ts:1:");
    expect(grepWorkspace(FILES, "^export")).toContain("agent.ts:3:");
  });

  test("literal mode escapes regex metacharacters", () => {
    // As a regex, "tool({})" is valid but means tool followed by "{}" — it
    // matches nothing here. The failure is silent, which is exactly why
    // literal mode needs to exist.
    expect(grepWorkspace(FILES, "tool({})")).toBe("No matches found");
    expect(grepWorkspace(FILES, "tool({})", { literal: true })).toContain("agent.ts:2:");
  });

  test("an invalid regex is an actionable error, not a crash", () => {
    expect(() => grepWorkspace(FILES, "[unclosed")).toThrow(StudioGrepError);
    expect(() => grepWorkspace(FILES, "[unclosed")).toThrow(/literal: true/);
  });

  test("ignoreCase is opt-in", () => {
    expect(grepWorkspace(FILES, "ROLLDICE")).toBe("No matches found");
    expect(grepWorkspace(FILES, "ROLLDICE", { ignoreCase: true })).toContain("agent.ts:2:");
  });

  test("glob filters which files are searched", () => {
    const out = grepWorkspace(FILES, "rollDice", { glob: "*.ts" });
    expect(out).toContain("agent.ts:2:");
    expect(out).not.toContain("notes.md");
  });

  test("globs use picomatch semantics: ** spans segments, * stays in one", () => {
    const nested = { ...FILES, "lib/util.ts": "export const rollDiceHelper = 1;\n" };
    // `*` must not cross a `/` …
    expect(grepWorkspace(nested, "rollDice", { glob: "*.ts" })).not.toContain("lib/util.ts");
    // … while `**/*.ts` matches both nested files and top-level ones.
    const out = grepWorkspace(nested, "rollDice", { glob: "**/*.ts" });
    expect(out).toContain("lib/util.ts:1:");
    expect(out).toContain("agent.ts:2:");
  });

  test("context lines are marked with a dash, matches with a colon", () => {
    const out = grepWorkspace(FILES, "const rollDice", { context: 1 });
    expect(out).toContain("agent.ts-1- ");
    expect(out).toContain("agent.ts:2: ");
    expect(out).toContain("agent.ts-3- ");
  });

  test("says so when results are capped, rather than looking complete", () => {
    const many = { "a.ts": Array.from({ length: 20 }, () => "hit").join("\n") };
    const out = grepWorkspace(many, "hit", { limit: 5 });
    expect(out.split("\n").filter((l) => l.startsWith("a.ts:"))).toHaveLength(5);
    expect(out).toContain("[Stopped at 5 matches.]");
  });

  test("elides very long matching lines", () => {
    const long = { "a.ts": `x${"y".repeat(500)}` };
    const out = grepWorkspace(long, "x");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(300);
  });

  test("skips absurdly long lines rather than backtracking on them", () => {
    // A model-supplied regex on a minified line is where catastrophic
    // backtracking would bite; the line is simply not searched.
    const minified = { "a.ts": "z".repeat(20_000) };
    expect(grepWorkspace(minified, "(z+)+$")).toBe("No matches found");
  });

  test("a glob picomatch refuses is an actionable error, not a crash", () => {
    expect(() => grepWorkspace(FILES, "rollDice", { glob: "a".repeat(70_000) })).toThrow(
      StudioGrepError,
    );
  });

  test("rejects an empty pattern", () => {
    expect(() => grepWorkspace(FILES, "")).toThrow(/must not be empty/);
  });
});
