// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { applyEdit, StudioEditError } from "./studio-edit.ts";

const FILE = `import { agent } from "@alexkroman1/aai";

export default agent({
  name: "My Agent",
  greeting: "Hi.",
});
`;

describe("applyEdit", () => {
  test("replaces a unique snippet and reports a diff", () => {
    const { content, diff } = applyEdit("agent.ts", FILE, '"My Agent"', '"Pizza Agent"');
    expect(content).toContain('name: "Pizza Agent"');
    expect(content).not.toContain('"My Agent"');
    // The diff is what the agent (and the reader) sees; it must show both sides.
    expect(diff).toContain('-4   name: "My Agent",');
    expect(diff).toContain('+4   name: "Pizza Agent",');
  });

  test("refuses an ambiguous match rather than editing the wrong one", () => {
    const doubled = 'const a = "x";\nconst b = "x";\n';
    expect(() => applyEdit("f.ts", doubled, '"x"', '"y"')).toThrow(/2 occurrences/);
    // The refusal must teach the way out — replaceAll is the rename escape.
    expect(() => applyEdit("f.ts", doubled, '"x"', '"y"')).toThrow(/replaceAll/);
  });

  test("replaceAll replaces every occurrence and reports the count", () => {
    const file = "const cnt = 1;\nuse(cnt);\nreturn cnt + cnt;\n";
    const { content, replacements } = applyEdit("f.ts", file, "cnt", "count", {
      replaceAll: true,
    });
    expect(content).toBe("const count = 1;\nuse(count);\nreturn count + count;\n");
    expect(replacements).toBe(4);
  });

  test("replaceAll terminates when the replacement contains the needle", () => {
    // Each replacement's output must not be re-matched, or "x" → "xx" loops.
    const { content, replacements } = applyEdit("f.ts", "x y x\n", "x", "xx", {
      replaceAll: true,
    });
    expect(content).toBe("xx y xx\n");
    expect(replacements).toBe(2);
  });

  test("replaceAll fuzzy-matches each occurrence independently", () => {
    const file = "say(“hi”);\nlog(“hi”);\n";
    const { content, replacements } = applyEdit("f.ts", file, '"hi"', '"yo"', {
      replaceAll: true,
    });
    expect(content).toBe('say("yo");\nlog("yo");\n');
    expect(replacements).toBe(2);
  });

  test("replaceAll still refuses a missing match", () => {
    expect(() => applyEdit("f.ts", FILE, "absent", "x", { replaceAll: true })).toThrow(
      StudioEditError,
    );
  });

  test("a single-match edit reports one replacement", () => {
    expect(applyEdit("agent.ts", FILE, '"My Agent"', '"Other"').replacements).toBe(1);
  });

  test("refuses a missing match instead of guessing", () => {
    expect(() => applyEdit("agent.ts", FILE, "not in the file", "x")).toThrow(StudioEditError);
    expect(() => applyEdit("agent.ts", FILE, "not in the file", "x")).toThrow(
      /must match the file/,
    );
  });

  test("tolerates smart quotes and trailing whitespace in the model's copy", () => {
    // Models routinely quote source back with curly quotes or stripped
    // trailing space; an exact-only match would reject a correct edit.
    const smart = "name: “My Agent”";
    const file = `x\n${smart}\ny\n`;
    const { content } = applyEdit("f.ts", file, 'name: "My Agent"', 'name: "Renamed"');
    expect(content).toContain('name: "Renamed"');
  });

  test("a fuzzy match rewrites only the matched region, byte-for-byte", () => {
    // Line 1 carries an em dash, curly quotes, and trailing whitespace; the
    // edit fuzzy-matches line 5 (straight quotes in the needle vs curly in
    // the file). Splicing into the normalized haystack used to silently
    // rewrite line 1's unicode — and diff normalized-vs-normalized hid it.
    const line1 = "// “Header” — with unicode   ";
    const file = `${line1}\na\nb\nc\nname: “My Agent”\n`;
    const { content, diff } = applyEdit("f.ts", file, 'name: "My Agent"', 'name: "Renamed"');
    expect(content.split("\n")[0]).toBe(line1);
    expect(content).toContain('name: "Renamed"');
    // The diff must show only the changed line 5 region, never line 1.
    expect(diff).toContain("Renamed");
    expect(diff).not.toContain("Header");
  });

  test("a fuzzy match keeps trailing whitespace outside the needle", () => {
    // The stripped trailing spaces sit after the matched region; they belong
    // to the file, not to the edit.
    const file = "value: “x”   \nrest\n";
    const { content } = applyEdit("f.ts", file, 'value: "x"', 'value: "y"');
    expect(content).toBe('value: "y"   \nrest\n');
  });

  test("preserves CRLF line endings", () => {
    const crlf = 'a\r\nname: "My Agent"\r\nb\r\n';
    const { content } = applyEdit("f.ts", crlf, '"My Agent"', '"Other"');
    expect(content).toContain("\r\n");
    expect(content).not.toMatch(/[^\r]\n/);
  });

  test("a mixed-endings file keeps its majority ending", () => {
    // First-newline sniffing would have homogenized this CRLF-majority file
    // to LF just because an LF line came first.
    const mixed = 'x: 1\na\r\nname: "My Agent"\r\nb\r\n';
    const { content } = applyEdit("f.ts", mixed, '"My Agent"', '"Other"');
    expect(content).toContain('"Other"');
    expect(content.match(/\r\n/g)).toHaveLength(4);
    expect(content).not.toMatch(/[^\r]\n/);
  });

  test("an LF-majority file with a stray CRLF stays LF", () => {
    const mixed = 'a\r\nb\nname: "My Agent"\nc\n';
    const { content } = applyEdit("f.ts", mixed, '"My Agent"', '"Other"');
    expect(content).not.toContain("\r");
  });

  test("preserves a leading BOM", () => {
    const { content } = applyEdit("f.ts", `﻿${FILE}`, '"My Agent"', '"Other"');
    expect(content.startsWith("﻿")).toBe(true);
  });

  test("rejects an empty oldText", () => {
    expect(() => applyEdit("f.ts", FILE, "", "x")).toThrow(/must not be empty/);
  });

  test("rejects a no-op replacement", () => {
    expect(() => applyEdit("f.ts", FILE, '"My Agent"', '"My Agent"')).toThrow(/No change/);
  });

  test("a diff too expensive to compute is elided, not a multi-second stall", () => {
    // Myers is O(N·D): two mostly-different files at the workspace size cap
    // measure ~7s of synchronous main-thread time. The edit must still apply,
    // with the presentation diff bounded by its budget.
    // The stall is prevented by the BUDGET, and `diff omitted` is the budget
    // reporting that it declined the computation — so that assertion is the
    // invariant. A wall-clock bound next to it measured the runner, and was
    // the only thing here that could fail for a reason unrelated to the code.
    const n = 6400;
    const before = Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const after = Array.from({ length: n }, (_, i) => `LINE ${n - i} ${"y".repeat(30)}`).join("\n");
    const result = applyEdit("f.ts", before, before, after);
    expect(result.content).toBe(after);
    expect(result.diff).toContain("diff omitted");
  });
});
