// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { formatRejection, syntaxError } from "./studio-syntax.ts";

const DIR = process.cwd();

// NOT covered here: the memo's reset-on-failure (see `loadTransformer`). The
// only way to provoke it is a `require.resolve("vite")` that throws, and vitest
// patches `createRequire` so that resolve succeeds from ANY directory —
// including one with no `node_modules` above it at all. A test that appeared to
// exercise it would be asserting against the runner, not the module.

describe("syntaxError", () => {
  test("accepts a valid module", async () => {
    expect(await syntaxError(DIR, "agent.ts", "export const x: number = 1;\n")).toBeUndefined();
  });

  test("catches the over-escaped string that caused the death spiral", async () => {
    // The exact shape observed: \" where " belonged, written as 4863 valid-
    // looking bytes and only noticed by a full build several steps later.
    const bad = 'export default agent({\n  systemPrompt: \\"You are a bot.\\",\n});\n';
    const problem = await syntaxError(DIR, "agent.ts", bad);
    expect(problem).toBeDefined();
    expect(problem).toMatch(/agent\.ts:2/);
  });

  test("catches a truncated file", async () => {
    expect(await syntaxError(DIR, "agent.ts", 'const a = { b: "unterminated')).toBeDefined();
  });

  test("checks tsx", async () => {
    expect(await syntaxError(DIR, "client.tsx", "const a = <div>;\n")).toBeDefined();
    expect(
      await syntaxError(DIR, "client.tsx", "export const A = () => <div />;\n"),
    ).toBeUndefined();
  });

  test("ignores files it has no parser for", async () => {
    // A prose file is not the tool's business; refusing it would block work.
    expect(await syntaxError(DIR, "README.md", "# not { valid ts")).toBeUndefined();
  });

  test("type errors are NOT syntax errors — mid-refactor files must still save", async () => {
    // Post-write diagnostics/test_agent own type correctness; this gate is
    // only about whether the file can be parsed at all.
    expect(await syntaxError(DIR, "agent.ts", "const x: number = 'a string';\n")).toBeUndefined();
  });
});

describe("formatRejection", () => {
  test("says nothing was written and names the likely cause", async () => {
    const msg = formatRejection("agent.ts", "line 2: Invalid character.");
    expect(msg).toContain("NOTHING was saved");
    expect(msg).toContain("line 2");
    expect(msg).toMatch(/escap/i);
  });
});
