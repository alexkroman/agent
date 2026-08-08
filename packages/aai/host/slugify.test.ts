// Copyright 2026 the AAI authors. MIT license.
// One normalization for every side that turns a human name into a slug —
// the studio's typed project names, its prompt-derived bases, and the CLI's
// directory-derived project name. These cases are the ones where the CLI's
// old hand-rolled `[^a-z0-9-_]` strip disagreed.
import { describe, expect, test } from "vitest";
import { MAX_SLUG_LENGTH, VALID_SLUG_RE } from "../sdk/slug.ts";
import { slugifyName } from "./slugify.ts";

describe("slugifyName", () => {
  test("transliterates rather than stripping non-ASCII", () => {
    // The motivating divergence: a regex strip leaves `caf-ordering`.
    expect(slugifyName("Café Ordering", MAX_SLUG_LENGTH)).toBe("cafe-ordering");
    expect(slugifyName("Ünïcôde Bot", MAX_SLUG_LENGTH)).toBe("uenicode-bot");
  });

  test("separators collapse — spaces, underscores, and runs of dashes", () => {
    expect(slugifyName("My Support Agent", MAX_SLUG_LENGTH)).toBe("my-support-agent");
    expect(slugifyName("my_agent", MAX_SLUG_LENGTH)).toBe("my-agent");
    expect(slugifyName("demo--x", MAX_SLUG_LENGTH)).toBe("demo-x");
  });

  test("a typed identifier is not decamelized", () => {
    // `decamelize: false` — the name is what the user typed, not a symbol
    // to prettify into `my-agent`.
    expect(slugifyName("MyAgent", MAX_SLUG_LENGTH)).toBe("myagent");
  });

  test("caps at maxLen and never ends on a separator", () => {
    // The cap can land mid-word, which is what leaves a trailing dash.
    expect(slugifyName("aaaa bbbb cccc", 10)).toBe("aaaa-bbbb");
    expect(slugifyName("aaaa bbbb cccc", 5)).toBe("aaaa");
  });

  test("a name with nothing usable in it reduces to empty, not to garbage", () => {
    // Callers decide what that means — the CLI refuses the directory name,
    // the platform falls back to a generated one.
    expect(slugifyName("!!!", MAX_SLUG_LENGTH)).toBe("");
    expect(slugifyName("日本語", MAX_SLUG_LENGTH)).toBe("");
  });

  test("anything non-empty it returns satisfies the slug grammar", () => {
    for (const input of ["Café Ordering", "My Support Agent", "my_agent", "MyAgent", "demo--x"]) {
      expect(VALID_SLUG_RE.test(slugifyName(input, MAX_SLUG_LENGTH))).toBe(true);
    }
  });
});
