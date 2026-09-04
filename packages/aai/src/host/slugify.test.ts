// Copyright 2026 the AAI authors. MIT license.
// One normalization for every side that turns a human name into a slug —
// the studio's typed project names, its prompt-derived bases, and the CLI's
// directory-derived project name. These cases are the ones where the CLI's
// old hand-rolled `[^a-z0-9-_]` strip disagreed.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { MAX_SLUG_LENGTH, VALID_SLUG_RE } from "../sdk/slug.ts";
import { slugifyName } from "./slugify.ts";

/**
 * The character grammar `slugifyName` really guarantees: lowercase
 * alphanumerics and interior single dashes, with no length floor.
 *
 * Deliberately NOT `VALID_SLUG_RE`, which additionally requires TWO
 * characters — see "a one-character result is not a slug" below. Spelled out
 * here rather than imported because the point of these properties is to state
 * what this function promises independently of what the platform accepts; the
 * two are related by the length-floor test, which asserts the relation.
 */
const SLUG_CHARS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Names, not codepoints: full-unicode graphemes, which is what a human types
 * and what the transliteration tables exist for. `fc.string()`'s default unit
 * is ASCII, and an ASCII-only corpus never reaches the case that motivated
 * this module (`Café Ordering`) or the ones that broke its stated grammar
 * (`日X`, `Ⅻ Y+-` — a name whose only usable output is one character).
 */
const names = fc.string({ unit: "grapheme" });

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

  test("anything it returns is empty or in the slug CHARACTER grammar", () => {
    // This test used to be titled "anything non-empty it returns satisfies
    // the slug grammar" and to loop over five hand-picked names, every one of
    // them five characters or longer. The claim was false — `fc.string()`
    // shrinks it to `"0"` in milliseconds — and the sample was what hid it.
    fc.assert(
      fc.property(names, fc.integer({ min: 1, max: MAX_SLUG_LENGTH }), (input, maxLen) => {
        const slug = slugifyName(input, maxLen);
        expect(slug === "" || SLUG_CHARS_RE.test(slug)).toBe(true);
      }),
    );
  });

  test("never exceeds maxLen and never ends on a separator", () => {
    fc.assert(
      fc.property(names, fc.integer({ min: 1, max: MAX_SLUG_LENGTH }), (input, maxLen) => {
        const slug = slugifyName(input, maxLen);
        expect(slug.length).toBeLessThanOrEqual(maxLen);
        expect(slug.endsWith("-")).toBe(false);
        expect(slug.startsWith("-")).toBe(false);
      }),
    );
  });

  test("is idempotent — slugifying a slug returns it unchanged", () => {
    // Untested for as long as the function existed, and load-bearing for the
    // bug it was written for: the CLI slugifies a directory name and the
    // studio slugifies a typed one, so the same project's name passes through
    // this function a second time whenever a slug is round-tripped through a
    // human-facing field. A second pass that moved it would be the SAME
    // "one human name, two projects" failure by a slower route.
    fc.assert(
      fc.property(names, fc.integer({ min: 1, max: MAX_SLUG_LENGTH }), (input, maxLen) => {
        const once = slugifyName(input, maxLen);
        expect(slugifyName(once, maxLen)).toBe(once);
      }),
    );
  });

  test("a one-character result is NOT a platform slug — the callers' boundary", () => {
    // `VALID_SLUG_RE` requires two characters, so these are all legitimate
    // outputs of this function that the platform refuses. They are the
    // measured counterexamples to the claim the property above replaced; a
    // one-letter project name is a plausible thing for a person to type, and
    // what happens then is the CALLER's decision, not this function's — the
    // studio answers "Project name must contain at least two letters or
    // numbers", the CLI refuses the directory name.
    expect(slugifyName("b", MAX_SLUG_LENGTH)).toBe("b");
    expect(slugifyName("日X", MAX_SLUG_LENGTH)).toBe("x");
    expect(slugifyName("\té+日", MAX_SLUG_LENGTH)).toBe("e");
    expect(slugifyName("Ⅻ Y+-", MAX_SLUG_LENGTH)).toBe("y");
    expect(slugifyName("ab cd", 1)).toBe("a");
    for (const short of ["b", "x", "e", "y", "a"]) {
      expect(VALID_SLUG_RE.test(short)).toBe(false);
    }
  });

  test("two characters or more IS the whole gap to the platform grammar", () => {
    // The strong claim, and the one worth having: the only way a result of
    // this function fails `VALID_SLUG_RE` is by being shorter than two
    // characters. So a caller that checks the length has checked everything.
    fc.assert(
      fc.property(names, fc.integer({ min: 1, max: MAX_SLUG_LENGTH }), (input, maxLen) => {
        const slug = slugifyName(input, maxLen);
        expect(slug.length < 2 || VALID_SLUG_RE.test(slug)).toBe(true);
      }),
    );
  });
});
