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

  test("preserves CRLF line endings", () => {
    const crlf = 'a\r\nname: "My Agent"\r\nb\r\n';
    const { content } = applyEdit("f.ts", crlf, '"My Agent"', '"Other"');
    expect(content).toContain("\r\n");
    expect(content).not.toMatch(/[^\r]\n/);
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
});
