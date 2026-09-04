// Copyright 2026 the AAI authors. MIT license.
/**
 * The reduced-motion block in the published stylesheet.
 *
 * `styles.css` is the one artifact every client and every template imports, and
 * its `@media (prefers-reduced-motion: reduce)` rule is the only thing in the
 * repository that stops an animation nobody in this package named — a
 * template's own `dc-pulse`, `rt-slide-in`, `crisisPulse`, `ic-scanline`. That
 * makes it worth a spec twice over: it protects readers who will not file a bug
 * about it, and it is invisible to every other test here, since a suite that
 * mounts a component sees the class or the inline style and never the sheet.
 *
 * **A spec cannot render CSS**, so this asserts over the SOURCE. jsdom parses no
 * stylesheet we hand it, matches no media query and computes no cascade, so a
 * test that mounted `MessageList` and read `getComputedStyle` would report the
 * same inline `animation` string with the block present or deleted — it would
 * pass over the bug. Reading the text is the honest check available.
 *
 * **The `import.meta.glob(…, { query: "?raw" })` idiom the gate specs use does
 * not work on a CSS file, measured rather than assumed.** Vitest's `css: false`
 * default stubs every CSS request, and Vite's `isCSSRequest` matches on
 * `.css` followed by end-or-QUERY — so `?raw` is still a CSS request and the
 * glob answers `""`, as does a static `import css from "../styles.css?raw"`.
 * A spec built on it would search an empty string. `readFileSync` is what
 * `theme-css-vars.test.tsx` already reads this same file with, one directory
 * over, so this is the package's idiom rather than a workaround: it also THROWS
 * on a stylesheet that moved, where the glob would silently resolve to nothing.
 *
 * Three things keep the rest from passing vacuously, and the third was found by
 * A/B rather than by reasoning. The block is extracted by BALANCED BRACES and
 * the reader throws when it finds none, so a deleted rule fails rather than
 * searching an empty string; the first test pins the animations the block exists
 * to neutralise, so a read that returned some other file cannot report a healthy
 * sheet; and CSS COMMENTS ARE STRIPPED BEFORE ANYTHING IS SEARCHED. Commenting
 * the block out is how it would most plausibly be disabled — during a debugging
 * session, then committed — and to a text search a rule sitting inside a block
 * comment is indistinguishable from a live one. The first draft of this file
 * passed exactly that A/B, which is the failure it now exists to prevent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The stylesheet with its comments removed.
 *
 * Non-greedy, so a comment closes at its first terminator exactly as the CSS
 * parser closes it. It would also eat an opener sitting inside a `content:`
 * string, which this sheet has none of — and that trade is the right way round:
 * it would make a live rule invisible and FAIL the suite, where the alternative
 * makes a dead rule look live and PASS it.
 */
const withoutComments = (css: string): string => css.replaceAll(/\/\*[\s\S]*?\*\//g, "");

const STYLESHEET = withoutComments(
  readFileSync(join(import.meta.dirname, "../styles.css"), "utf8"),
);

const QUERY = "@media (prefers-reduced-motion: reduce)";

/**
 * The body of the block introduced by `opener`, read by matching braces.
 *
 * Throwing on absence is the load-bearing half: a reader answering `""` would
 * turn a deleted media query into four assertions quietly searching an empty
 * string, which is the shape of gate failure this repo keeps paying for.
 */
function blockBody(source: string, opener: string): string {
  const at = source.indexOf(opener);
  if (at < 0) throw new Error(`styles.css declares no ${opener}`);
  const open = source.indexOf("{", at + opener.length);
  if (open < 0) throw new Error(`${opener} is not followed by a block`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${opener} opens a block that is never closed`);
}

/** The selector list of the first rule in a block, as written. */
function selectorsOf(body: string): string[] {
  const open = body.indexOf("{");
  if (open < 0) throw new Error("the reduced-motion block contains no rule");
  return body
    .slice(0, open)
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

describe("prefers-reduced-motion in the published stylesheet", () => {
  test("the sheet under test is the one that ships the infinite animations", () => {
    // Non-vacuity. Everything below searches this string, and these two lines
    // are what say so if it is ever the wrong file — they are also exactly the
    // rules the block has to outrank.
    expect(STYLESHEET).toContain("@keyframes aai-shimmer");
    expect(STYLESHEET).toContain("animation: aai-shimmer 2s infinite");
  });

  test("declares the media query", () => {
    expect(STYLESHEET).toContain(QUERY);
    // And it is a real block rather than a mention in prose.
    expect(blockBody(STYLESHEET, QUERY).trim()).not.toBe("");
  });

  test("targets a UNIVERSAL selector, which is what reaches a template's own keyframes", () => {
    // The whole leverage of putting this in the published sheet: a template
    // declares `dc-pulse` / `ic-scanline` / `crisisPulse` in its own inline
    // `<style>`, and nothing here knows those names. Narrow this selector to a
    // class or to this package's components and every one of them starts
    // running again, with no other test in the repo noticing.
    const selectors = selectorsOf(blockBody(STYLESHEET, QUERY));
    expect(selectors).toContain("*");
    // Pseudo-elements are separate boxes and animate independently of their
    // originating element, so a bare `*` alone would leave them moving.
    expect(selectors).toContain("*::before");
    expect(selectors).toContain("*::after");
  });

  test("names all four properties, each !important", () => {
    // Four, because motion arrives four ways and dropping one leaves a whole
    // family unaddressed: keyframes (duration AND count), transitions, and
    // CSS-driven scrolling.
    const body = blockBody(STYLESHEET, QUERY);
    for (const property of [
      "animation-duration",
      "animation-iteration-count",
      "transition-duration",
      "scroll-behavior",
    ]) {
      const value = new RegExp(`${property}\\s*:\\s*([^;]+);`).exec(body)?.[1];
      expect(value, `${property} is not declared`).toBeTypeOf("string");
      // Without `!important` this loses to Tailwind's `animate-pulse`, to a
      // template's own `<style>` block, and to the inline `style={{ animation }}`
      // that `ConsoleShell` and `MessageList` write.
      expect(value, `${property} is not !important`).toContain("!important");
    }
  });

  test("stops an infinite animation rather than merely speeding it up", () => {
    const body = blockBody(STYLESHEET, QUERY);
    // The count is what ENDS it. Cutting the duration alone leaves `infinite`
    // infinite, only faster — strictly worse than the animation it replaced.
    expect(/animation-iteration-count\s*:\s*1\s*!important/.test(body)).toBe(true);
    // The durations are non-zero on purpose: a zero-duration animation or
    // transition fires no `animationend` / `transitionend`, so anything
    // awaiting one waits forever.
    for (const property of ["animation-duration", "transition-duration"]) {
      const value = new RegExp(`${property}\\s*:\\s*([^\\s;!]+)`).exec(body)?.[1];
      expect(value, `${property} has no value`).toBeTypeOf("string");
      expect(Number.parseFloat(value ?? "0"), `${property} is zero`).toBeGreaterThan(0);
    }
  });
});
