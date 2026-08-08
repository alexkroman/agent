#!/usr/bin/env node

/**
 * Assertion gate: every `test()` / `it()` body must assert something.
 *
 * A test with no assertion still runs the code, still counts in the green
 * "442 passed", and still shows up in coverage — while checking nothing but
 * "did not throw synchronously". That is the worst failure mode a suite has,
 * because it is indistinguishable from real coverage at every level a human
 * or a CI dashboard looks at.
 *
 * The ones this gate was written against were not hypothetical:
 *
 * - `"/health returns ok JSON"` created a server, never sent a request, and
 *   asserted nothing. It passed whatever `/health` returned — a real version
 *   of the same test lived 30 lines below it.
 * - `"onHistory appends and onUserTranscript pushes user messages"` called
 *   three methods and checked none of the three claims in its own name.
 * - `"does not block different keys on each other"` encoded its invariant as
 *   a bare `await`: a regression made it HANG to the suite timeout rather
 *   than fail.
 *
 * "Does not throw" is a legitimate thing to test — it just has to be said:
 * `expect(fn).not.toThrow()`, `await expect(p).resolves.toBeUndefined()`.
 * Writing it down is what makes it survive a refactor and what tells the next
 * reader the empty body was deliberate.
 *
 * There is deliberately NO allowlist. The baseline is zero, like
 * `file-length-allowlist.json`'s empty state — an escape hatch here would be
 * indistinguishable from the bug.
 *
 * Wired up as `pnpm check:test-assertions`, in `scripts/check.sh` and the CI
 * check job (both — see the root CLAUDE.md on ratchets that lived in only one).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Calls that count as asserting. `expectTypeOf` is included because the
 * type-level suites assert at compile time and legitimately have no runtime
 * `expect`; the `[(.<]` tail admits `expect.soft(…)`, `expect.poll(…)` and
 * `expect.hasAssertions()` alongside a bare call.
 */
const ASSERTION = /\b(?:expect|expectTypeOf|assert)\s*[(.<]/;

/**
 * Openers for a test body. `test.each(…)` / `it.skipIf(…)` included.
 *
 * The lookbehind is load-bearing: `\b` alone treats the `test` in
 * `/re/.test(x)` as an opener, and this repo calls `RegExp.prototype.test`
 * inside test files constantly — it accounted for five of the eight hits the
 * first version reported.
 */
const TEST_OPENER = /(?<![.\w$])(?:test|it)\s*(?:\.\s*\w+\s*\([\s\S]*?\)\s*)?\(/g;

/**
 * Blank out everything that is not code — comments and the literal text of
 * strings — replacing each masked character with a space so every offset and
 * line number still lines up with the original source.
 *
 * This is the whole reason the gate is trustworthy. Scanning raw text finds
 * `test()` inside a JSDoc paragraph *about* tests (three files here have one)
 * and finds `expect` inside a string that merely mentions it. Template
 * substitutions are deliberately left UNMASKED: `${…}` is code, and an
 * assertion can legitimately live inside one.
 *
 * Hand-rolled rather than pulled from a parser: these scripts are plain node
 * with no build step, and the repo's only TypeScript parser (`typescript@6`)
 * lives in the `docs/` workspace for TypeDoc's sake.
 */
/** Index just past the `//` comment starting at `i`. */
function endOfLineComment(src, i) {
  const nl = src.indexOf("\n", i);
  return nl === -1 ? src.length : nl;
}

/** Index just past the `/* *\/` comment starting at `i`. */
function endOfBlockComment(src, i) {
  const end = src.indexOf("*/", i + 2);
  return end === -1 ? src.length : end + 2;
}

/** Index of the closing `/` of the regex literal at `i`, or -1 if unterminated. */
function endOfRegex(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "\n") return -1;
    else if (c === "/" && !inClass) return j;
  }
  return -1;
}

/** Index of the closing quote of the `'`/`"` string at `i` (or its newline). */
function endOfQuoted(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === quote || src[j] === "\n") return j;
  }
  return src.length;
}

/** Index just past the `}` closing the `${` at `i`. */
function endOfSubstitution(src, i) {
  let braces = 1;
  for (let j = i + 2; j < src.length; j++) {
    if (src[j] === "{") braces++;
    else if (src[j] === "}" && --braces === 0) return j + 1;
  }
  return src.length;
}

/**
 * Blank the literal text of the template starting at `i`, leaving every
 * `${…}` intact — those are code, and an assertion can live inside one.
 * Returns the index of the closing backtick.
 */
function maskTemplate(src, i, blank) {
  let textStart = i + 1;
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "`") {
      blank(textStart, j);
      return j;
    } else if (src[j] === "$" && src[j + 1] === "{") {
      blank(textStart, j);
      j = endOfSubstitution(src, j) - 1;
      textStart = j + 1;
    }
  }
  blank(textStart, src.length);
  return src.length;
}

/** Whether a `/` after this character starts a regex rather than dividing. */
const REGEX_ALLOWED_AFTER = /[([{,;:=!&|?+\-*%~^<>]/;

/**
 * The fixed-extent non-code token starting at `i`, as the range to blank plus
 * the index to resume the outer scan from — or null when `i` is ordinary
 * code. `prev` is the previous significant character, which is what decides
 * whether a `/` opens a regex or divides.
 *
 * Templates are NOT handled here: they blank several disjoint ranges (the
 * literal text between substitutions), which does not fit one span.
 */
function nonCodeSpanAt(src, i, prev) {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") {
    const end = endOfLineComment(src, i);
    return { from: i, to: end, next: end - 1 };
  }
  if (c === "/" && src[i + 1] === "*") {
    const end = endOfBlockComment(src, i);
    return { from: i, to: end, next: end - 1 };
  }
  if (c === "/" && (prev === "" || REGEX_ALLOWED_AFTER.test(prev))) {
    const end = endOfRegex(src, i);
    // -1 means unterminated, i.e. it was division after all.
    if (end !== -1) return { from: i + 1, to: end, next: end };
  }
  if (c === '"' || c === "'") {
    const end = endOfQuoted(src, i);
    return { from: i + 1, to: end, next: end };
  }
  return null;
}

function maskNonCode(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };
  // The previous significant character, which is what decides `/`.
  let prev = "";

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "`") {
      i = maskTemplate(src, i, blank);
    } else {
      const span = nonCodeSpanAt(src, i, prev);
      if (span === null) {
        if (!/\s/.test(c)) prev = c;
        continue;
      }
      blank(span.from, span.to);
      i = span.next;
    }
    prev = c;
  }
  return out.join("");
}

/**
 * Source text of the call whose opening `(` is at `open`, or null at EOF.
 * Runs over masked source, so quotes and comments cannot unbalance it.
 */
function readCall(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return masked.slice(open, i + 1);
    }
  }
  return null;
}

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.test.ts", "*.test.tsx"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
)
  .split("\n")
  .filter(Boolean)
  // Built copies of the template tests ship in the CLI's dist; the sources
  // they came from are already in the list.
  .filter((f) => !(f.includes("/dist/") || f.includes("node_modules/")));

const offenders = [];
let scanned = 0;

for (const file of files) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const masked = maskNonCode(src);
  TEST_OPENER.lastIndex = 0;
  for (let m = TEST_OPENER.exec(masked); m !== null; m = TEST_OPENER.exec(masked)) {
    const open = m.index + m[0].length - 1;
    const call = readCall(masked, open);
    if (call === null) continue;
    // Skip past this call so a nested `test()` inside a helper isn't counted
    // twice.
    TEST_OPENER.lastIndex = open + call.length;
    scanned++;
    if (ASSERTION.test(call)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    // Titles come from the ORIGINAL source — the masked copy blanked them.
    const title = /^\(\s*(["'`])([\s\S]*?)\1/.exec(src.slice(open, open + call.length))?.[2];
    offenders.push({ file, line, title: title?.replace(/\s+/g, " ") ?? "(untitled)" });
  }
}

if (offenders.length > 0) {
  console.error(
    `check-test-assertions: ${offenders.length} of ${scanned} test(s) assert nothing — they pass no matter what the code does.\n`,
  );
  for (const { file, line, title } of offenders) {
    console.error(`  ${file}:${line}  ${title}`);
  }
  console.error(
    '\nAssert the claim in the test\'s name. If the claim really is "does not throw",\n' +
      "say so: expect(fn).not.toThrow() / await expect(p).resolves.toBeUndefined().",
  );
  process.exit(1);
}

console.log(
  `check-test-assertions: all ${scanned} test(s) across ${files.length} file(s) assert something. ✓`,
);
