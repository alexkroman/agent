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

  test("keeps '=' inside a value; '#' needs quoting (.env comment syntax)", () => {
    // Base64 and URLs routinely contain '='. An unquoted '#' starts an
    // inline comment in .env syntax — quoting the value keeps it literal.
    expect(parseSecrets('A=b=c==\nB=https://x/y#frag\nC="https://x/y#frag"')).toEqual({
      A: "b=c==",
      B: "https://x/y",
      C: "https://x/y#frag",
    });
  });

  test("keeps multi-line quoted values intact (PEM keys, JSON)", () => {
    // The whole point of real .env parsing: a pasted PEM key or
    // service-account JSON spans lines inside one quoted value.
    const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";
    expect(parseSecrets(`A="${pem}"\nB=1`)).toEqual({ A: pem, B: "1" });
  });

  test("expands \\n escapes in double-quoted values only", () => {
    expect(parseSecrets("A=\"line1\\nline2\"\nB='raw\\nvalue'")).toEqual({
      A: "line1\nline2",
      B: "raw\\nvalue",
    });
  });

  test("skips lines with no key", () => {
    expect(parseSecrets("=novalue\njusttext\nA=1")).toEqual({ A: "1" });
  });
});
