// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The doc-example corpus reader, over samples.
 *
 * `parseDeclaredMarkdown` is split from `declaredMarkdown` precisely so this
 * file can exercise the THROW: a reader that answered `[]` on a renamed
 * `MARKDOWN_FILES` would turn every per-document assertion in both
 * doc-examples specs into a statement about an empty corpus, and that path is
 * unreachable from a tree where the constant is present.
 *
 * Co-located rather than folded into `_gate-support.test.ts`, per
 * `check:module-tests`: coverage borrowed from a test written for something
 * else moves whenever that other test does.
 */

import { describe, expect, test } from "vitest";
import { parseDeclaredMarkdown } from "./_doc-example-corpus.ts";

describe("parseDeclaredMarkdown", () => {
  test("reads the gate's list, sorted", () => {
    const source = 'const MARKDOWN_FILES = [\n  "b.md",\n  "a.md",\n];\n';
    expect(parseDeclaredMarkdown(source)).toEqual(["a.md", "b.md"]);
  });

  test("THROWS when the declaration is gone, rather than answering an empty corpus", () => {
    expect(() => parseDeclaredMarkdown("const OTHER = [];")).toThrow(
      /no longer declares MARKDOWN_FILES/,
    );
  });
});
