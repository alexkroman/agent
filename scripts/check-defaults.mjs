// Copyright 2026 the AAI authors. MIT license.
/**
 * Every STATED default agrees with the constant that IS the default.
 *
 *   pnpm check:defaults
 *
 * A default lives in one place — an `export const DEFAULT_*` in
 * `packages/aai/src/sdk/` — and is RESTATED in at least four: the field's
 * `@defaultValue` JSDoc (what an editor's hover and the API reference show),
 * the docs site's tuning table, the authoring guide's `agent()` field listing,
 * and that guide's prose. Nothing tied the restatements to the constant, and
 * they drifted: `minBargeInWords` moved from 2 to 1 and its JSDoc, the docs
 * table and the guide kept saying 2; the docs table said `maxTurnSilenceMs` was
 * 3000 and the guide said 1600, against a constant of 3500. Moving one constant
 * (`DEFAULT_DEAD_AIR_COVER_MS`) touched eleven files by hand. This gate reads
 * the constants' real VALUES (Node strips the types, so the modules import as
 * they are) and fails on any restatement that disagrees.
 *
 * ## What it checks
 *
 * 1. **Every `@defaultValue` in `packages/aai/src/sdk/**`** whose text opens
 *    with a backticked literal. Its constant is the one the tag names (the
 *    first backticked or `{@link}`ed SCREAMING_CASE identifier in the tag's
 *    paragraph), or — for a tag on an `export const` declaration — that
 *    declaration. The literal must equal the constant's value. A NUMERIC
 *    literal that names no constant is itself a failure: a bare number in a
 *    doc comment is exactly the restatement nothing can check.
 * 2. **The docs site's "Tuning the conversation" table**
 *    (`docs/src/content/docs/more/voices-and-models.md`): a row whose Default
 *    cell opens with a backticked literal must match the `@defaultValue` of the
 *    field it names, as established by (1).
 * 3. **The authoring guide** (`packages/aai-templates/scaffold/CLAUDE.md`, the
 *    single source `AGENT_GUIDE.md` and the studio prompts are synced from):
 *    every "(default X)" stated for a backticked field, in the `agent()`
 *    listing's comments or in prose, must match that field's `@defaultValue`.
 *
 * Floors guard the "printed a checkmark over nothing" failure: a parser that
 * stopped matching would compare an empty set with an empty set.
 */

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { parseScriptArgs } from "./_args.mjs";
import { repoRoot } from "./_fs.mjs";
import { assertScanCorpus, git } from "./_ratchet.mjs";

parseScriptArgs({ script: import.meta.url, options: {} });

const ROOT = repoRoot(import.meta.url);
const SDK_PATHSPEC = "packages/aai/src/sdk";
const SDK_DIR = join(ROOT, SDK_PATHSPEC);
const DOCS_TABLE_PATH = join(ROOT, "docs/src/content/docs/more/voices-and-models.md");
const DOCS_TABLE_HEADING = "## Tuning the conversation";
const GUIDE_PATH = join(ROOT, "packages/aai-templates/scaffold/CLAUDE.md");

/** Measured 2026-10: 494 files under the SDK directory, 281 of them non-test `.ts`. */
const MIN_SDK_FILES = 400;
/** Measured 2026-10: 25 literal `@defaultValue` tags, 19 of them tied to a constant. */
const MIN_LITERAL_TAGS = 15;
const MIN_CONSTANT_TAGS = 10;
/** Measured 2026-10: 6 table rows, 5 with a literal default. */
const MIN_TABLE_ROWS = 4;
/** Measured 2026-10: 10 "(default X)" statements for a documented field. */
const MIN_GUIDE_STATEMENTS = 8;

const rel = (path) => relative(ROOT, path);

/**
 * The SDK's non-test `.ts` sources, absolute, each read ONCE for both passes.
 * Listed from git (the index plus new, unignored files) under a corpus floor.
 *
 * @returns {Map<string, string>} absolute path -> source
 */
function sdkSources() {
  assertScanCorpus({
    gate: "check-defaults",
    what: SDK_PATHSPEC,
    pathspecs: [SDK_PATHSPEC],
    minFiles: MIN_SDK_FILES,
  });
  const listed = git(["ls-files", "--cached", "--others", "--exclude-standard", "--", SDK_PATHSPEC])
    .split("\n")
    .filter((file) => /\.ts$/.test(file) && !/\.test(-d)?\.ts$/.test(file))
    .map((file) => join(ROOT, file));
  return new Map([...new Set(listed)].sort().map((path) => [path, readFileSync(path, "utf8")]));
}

/**
 * Line numbers for offsets into `source`, asked in NON-DECREASING order: each
 * call counts only the newlines since the previous one.
 *
 * @param {string} source
 */
function lineCounter(source) {
  let line = 1;
  let next = source.indexOf("\n");
  return (to) => {
    while (next !== -1 && next < to) {
      line += 1;
      next = source.indexOf("\n", next + 1);
    }
    return line;
  };
}

/**
 * Parse a stated literal into a comparable value, or `undefined` when it is not
 * one this gate understands (an expression, a type, prose).
 *
 * @param {string} text
 * @returns {{ value: unknown } | undefined}
 */
function parseLiteral(text) {
  const raw = text.trim();
  if (/^-?[0-9][0-9_]*(\.[0-9]+)?$/.test(raw)) return { value: Number(raw.replaceAll("_", "")) };
  if (raw === "true" || raw === "false") return { value: raw === "true" };
  const quoted = /^"([\s\S]*)"$/.exec(raw);
  if (quoted) return { value: quoted[1] };
  if (!raw.startsWith("[")) return;
  try {
    return { value: JSON.parse(raw) };
  } catch {
    // Not JSON (an expression or a type), so not a literal this gate reads.
  }
}

/** Strings compare whitespace-normalized, since a doc comment wraps them. */
const normalize = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : JSON.stringify(value);
const same = (a, b) => normalize(a) === normalize(b);
const show = (value) => JSON.stringify(value);

const problems = [];

// ---------------------------------------------------------------------------
// The constants, by value
// ---------------------------------------------------------------------------

const sources = sdkSources();
/** @type {Map<string, string>} constant name -> declaring file */
const declaredIn = new Map();
for (const [file, source] of sources) {
  for (const match of source.matchAll(/^export const ([A-Z][A-Z0-9_]+)\b/gm)) {
    declaredIn.set(match[1] ?? "", file);
  }
}

/** @type {Map<string, Record<string, unknown>>} */
const modules = new Map();
/** @param {string} name */
async function constantValue(name) {
  const file = declaredIn.get(name);
  if (file === undefined) return;
  if (!modules.has(file)) modules.set(file, await import(pathToFileURL(file).href));
  const mod = modules.get(file);
  return mod !== undefined && Object.hasOwn(mod, name) ? { value: mod[name] } : undefined;
}

// ---------------------------------------------------------------------------
// (1) Every @defaultValue in the SDK
// ---------------------------------------------------------------------------

/** @type {Map<string, { value: unknown, where: string }[]>} field -> stated defaults */
const fieldDefaults = new Map();
let literalTags = 0;
let constantTags = 0;

for (const [file, source] of sources) {
  const lineAt = lineCounter(source);
  for (const block of source.matchAll(/\/\*\*([\s\S]*?)\*\/\s*([^\n]*)/g)) {
    const body = block[1] ?? "";
    const tagAt = body.indexOf("@defaultValue");
    if (tagAt === -1) continue;
    const line = lineAt(block.index + 3 + tagAt);
    const where = `${rel(file)}:${line}`;
    // The tag's paragraph: up to the next tag or blank comment line, with the
    // ` * ` gutters stripped so a wrapped literal reads as one string.
    const paragraph = (
      body
        .slice(tagAt + "@defaultValue".length)
        .split("\n")
        .map((one) => one.replace(/^\s*\*\s?/, ""))
        .join("\n")
        .split(/\n\s*\n|\n\s*@/)[0] ?? ""
    )
      .replace(/\s*\n\s*/g, " ")
      .trim();
    const literalMatch = /^`([^`]+)`/.exec(paragraph);
    if (literalMatch === null) continue;
    const literal = parseLiteral(literalMatch[1] ?? "");
    if (literal === undefined) {
      problems.push(
        `${where}: \`@defaultValue \`${literalMatch[1]}\`\` is not a literal this gate can read.`,
      );
      continue;
    }
    literalTags += 1;

    const declaration = block[2] ?? "";
    const ownConstant = /^export const ([A-Z][A-Z0-9_]+)\b/.exec(declaration)?.[1];
    const namedConstant = /(?:`|\{@link\s+)([A-Z][A-Z0-9_]{2,})(?:`|\})/.exec(
      paragraph.slice(literalMatch[0].length),
    )?.[1];
    const constant = ownConstant ?? namedConstant;
    if (constant !== undefined) {
      const resolved = await constantValue(constant);
      if (resolved === undefined) {
        problems.push(
          `${where}: names \`${constant}\`, which no module under ${rel(SDK_DIR)} exports.`,
        );
      } else {
        constantTags += 1;
        if (!same(resolved.value, literal.value)) {
          problems.push(
            `${where}: states \`${literalMatch[1]}\` but \`${constant}\` is ${show(resolved.value)}.`,
          );
        }
      }
    } else if (typeof literal.value === "number") {
      problems.push(
        `${where}: \`@defaultValue \`${literalMatch[1]}\`\` names no constant. Name the ` +
          "`DEFAULT_*` it restates, e.g. `@defaultValue `2400` (`DEFAULT_DEAD_AIR_COVER_MS`)`, " +
          "so this gate can hold the two together.",
      );
    }

    const field = /^(?:readonly\s+)?([a-zA-Z_$][\w$]*)\??:/.exec(declaration.trim())?.[1];
    if (field !== undefined) {
      const list = fieldDefaults.get(field) ?? [];
      list.push({ value: literal.value, where });
      fieldDefaults.set(field, list);
    }
  }
}

for (const [field, stated] of fieldDefaults) {
  if (stated.some((one) => !same(one.value, stated[0]?.value))) {
    problems.push(
      `\`${field}\` carries conflicting @defaultValue tags:\n` +
        stated.map((one) => `  ${one.where}: ${show(one.value)}`).join("\n"),
    );
  }
}

/** @param {string} field */
const defaultOf = (field) => fieldDefaults.get(field)?.[0];

if (literalTags < MIN_LITERAL_TAGS || constantTags < MIN_CONSTANT_TAGS) {
  problems.push(
    `Only ${literalTags} literal @defaultValue tags (floor ${MIN_LITERAL_TAGS}), ${constantTags} ` +
      `tied to a constant (floor ${MIN_CONSTANT_TAGS}), under ${rel(SDK_DIR)}. The JSDoc scan ` +
      "stopped matching, so nothing below was really compared.",
  );
}

// ---------------------------------------------------------------------------
// (2) The docs site's tuning table
// ---------------------------------------------------------------------------

const docs = readFileSync(DOCS_TABLE_PATH, "utf8");
const section = docs.split(DOCS_TABLE_HEADING)[1]?.split(/\n## /)[0] ?? "";
let tableRows = 0;
for (const row of section.matchAll(/^\|\s*`([\w.]+)`\s*\|.*\|\s*([^|]*?)\s*\|\s*$/gm)) {
  const field = (row[1] ?? "").split(".").at(-1) ?? "";
  const cell = row[2] ?? "";
  const literalMatch = /^`([^`]+)`/.exec(cell);
  if (literalMatch === null) continue;
  tableRows += 1;
  const stated = parseLiteral(literalMatch[1] ?? "");
  const truth = defaultOf(field);
  if (truth === undefined) {
    problems.push(
      `${rel(DOCS_TABLE_PATH)}: the row for \`${row[1]}\` states a default, but no ` +
        `\`@defaultValue\` under ${rel(SDK_DIR)} documents a field \`${field}\` to check it against.`,
    );
  } else if (stated === undefined || !same(stated.value, truth.value)) {
    problems.push(
      `${rel(DOCS_TABLE_PATH)}: \`${row[1]}\` default is \`${literalMatch[1]}\`, but ` +
        `${truth.where} (checked against its constant) says ${show(truth.value)}.`,
    );
  }
}
if (tableRows < MIN_TABLE_ROWS) {
  problems.push(
    `Only ${tableRows} rows with a literal default under "${DOCS_TABLE_HEADING}" in ` +
      `${rel(DOCS_TABLE_PATH)} (floor ${MIN_TABLE_ROWS}). The table moved or its parser stopped matching.`,
  );
}

// ---------------------------------------------------------------------------
// (3) The authoring guide
// ---------------------------------------------------------------------------

const guide = readFileSync(GUIDE_PATH, "utf8");
const guideLines = guide.split("\n");
let guideStatements = 0;
/**
 * @param {string} field
 * @param {string} statedText
 * @param {number} lineNo
 */
function checkGuide(field, statedText, lineNo) {
  const truth = defaultOf(field);
  if (truth === undefined) return;
  const stated = parseLiteral(statedText);
  if (stated === undefined) return;
  guideStatements += 1;
  if (!same(stated.value, truth.value)) {
    problems.push(
      `${rel(GUIDE_PATH)}:${lineNo}: says \`${field}\` defaults to ${statedText}, but ` +
        `${truth.where} (checked against its constant) says ${show(truth.value)}.`,
    );
  }
}

const DEFAULT_TEXT = String.raw`\(default ("[^"]*"|[\w.]+)`;
for (let i = 0; i < guideLines.length; i += 1) {
  // The `agent()` field listing: `  name?: type; // ... (default X)`, where the
  // comment may continue on lines that are only a `//` comment.
  const field = /^\s+([a-zA-Z_$][\w$]*)\??:\s.*?\/\//.exec(guideLines[i] ?? "")?.[1];
  if (field !== undefined) {
    let comment = (guideLines[i] ?? "").slice((guideLines[i] ?? "").indexOf("//"));
    for (let j = i + 1; /^\s*\/\//.test(guideLines[j] ?? ""); j += 1)
      comment += ` ${guideLines[j]}`;
    const stated = new RegExp(DEFAULT_TEXT).exec(comment)?.[1];
    if (stated !== undefined) checkGuide(field, stated, i + 1);
  }
}
// Prose: "`field` is how many words interrupt a reply (default 2, ...".
const flat = guide.replace(/\n/g, " ");
const lineOf = lineCounter(guide);
for (const match of flat.matchAll(
  new RegExp(String.raw`\`([a-zA-Z_$][\w$]*)\`[^\`(]{0,120}?${DEFAULT_TEXT}`, "g"),
)) {
  checkGuide(match[1] ?? "", match[2] ?? "", lineOf(match.index));
}
if (guideStatements < MIN_GUIDE_STATEMENTS) {
  problems.push(
    `Only ${guideStatements} "(default X)" statements for a documented field found in ` +
      `${rel(GUIDE_PATH)} (floor ${MIN_GUIDE_STATEMENTS}). The guide's parser stopped matching.`,
  );
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`check-defaults: ${problems.length} stated default(s) disagree with the code.\n`);
  for (const problem of problems) console.error(`${problem}\n`);
  console.error(
    "The constant is the default; fix the restatement. If the constant itself is what should move, " +
      "packages/aai/DEFAULTS-CLAUDE.md records the measurement each one rests on.",
  );
  process.exit(1);
}

console.log(
  `check-defaults: ${literalTags} @defaultValue tag(s) (${constantTags} against their constant), ` +
    `${tableRows} docs-table row(s) and ${guideStatements} guide statement(s) agree. ✓`,
);
