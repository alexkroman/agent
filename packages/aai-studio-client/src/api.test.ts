// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { parseSecrets } from "./api.ts";

describe("parseSecrets", () => {
  test("parses KEY=value lines", () => {
    expect(parseSecrets("A=1\nB=two")).toEqual({ A: "1", B: "two" });
  });

  test("strips surrounding quotes", () => {
    // The publish panel invites pasting from a .env file, where quoting a
    // value is normal — the quotes are syntax, not part of the secret.
    expect(parseSecrets("A=\"pk-abc\"\nB='sk-xyz'")).toEqual({ A: "pk-abc", B: "sk-xyz" });
  });

  test("ignores comments and blank lines", () => {
    expect(parseSecrets("# a comment\n\nA=1\n   # indented\n")).toEqual({ A: "1" });
    // The dangerous one: a commented-out secret must not come back to life.
    expect(parseSecrets("# B=old-key\nA=1")).toEqual({ A: "1" });
  });

  test("accepts an `export ` prefix", () => {
    expect(parseSecrets("export A=1")).toEqual({ A: "1" });
  });

  test("keeps '=' and '#' inside a value", () => {
    // Base64 and URLs routinely contain '='; only a *leading* '#' is a comment.
    expect(parseSecrets("A=b=c==\nB=https://x/y#frag")).toEqual({
      A: "b=c==",
      B: "https://x/y#frag",
    });
  });

  test("skips lines with no key", () => {
    expect(parseSecrets("=novalue\njusttext\nA=1")).toEqual({ A: "1" });
  });
});
