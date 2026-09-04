// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * Guards `konsistent.json` — the structural conventions `pnpm check:konsistent`
 * enforces.
 *
 * konsistent checks the shapes no per-file tool can see, because none of them
 * is wrong WITHIN a file: a provider module that exports four of its five
 * symbols, a `*-barrel.ts` that grew a local declaration, a package importing
 * across a boundary the dependency graph forbids. Biome lints statements, tsc
 * type-checks a program; neither can say "every module in this directory must
 * look like its siblings."
 *
 * It shares the failure mode of every gate in this repo whose success output is
 * a count: **a convention that matches nothing passes.** A typo in a `paths`
 * glob (`packages/aai/src/sdk/provider/` for `providers/`) silently checks zero
 * files and prints the same "No violations found" as a healthy run, and unlike
 * a broken lint rule there is no error anywhere to notice. So the tests here
 * assert the config's SHAPE — that each convention is named, described, and
 * points at paths that exist — rather than trusting a green run.
 *
 * The wiring test is the other half. The quality ratchets lived only in
 * `scripts/check.mjs` for a long time, which CI never invokes, so
 * `git push --no-verify` skipped them entirely; a new gate has to be in both
 * places or it is enforced by a hook the author can bypass.
 *
 * This lives in aai-templates for the same reason `claude-md-limit.test.ts`
 * and `test-assertion-gate.test.ts` do: it is the package that owns
 * repo-level meta checks, and `?raw` imports reach repo-root files without
 * node types, which this package's tsconfig has none of.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, repoPathOf, sole } from "./_gate-support.ts";

/**
 * The `must` half of a convention, in either of the two shapes konsistent
 * accepts: one predicate object, or a list of conditional blocks.
 */
type MustBlock = {
  name?: string;
  if?: Record<string, unknown>;
  for?: { files: string | string[] };
  must?: Record<string, unknown>;
  mustNot?: Record<string, unknown>;
};

type Convention = {
  name?: string;
  description?: string;
  paths: string | string[];
  must?: Record<string, unknown> | MustBlock[];
  mustNot?: Record<string, unknown>;
};

type KonsistentConfig = {
  $schema?: string;
  version: string;
  kebabToPascalMap?: Record<string, string>;
  kebabToCamelMap?: Record<string, string>;
  conventions: Convention[];
};

const raw = sole(
  import.meta.glob("../../../konsistent.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
) as string | undefined;

/**
 * Repo-relative paths of everything a convention could plausibly point at, so a
 * glob typo has something concrete to fail against.
 *
 * Vite resolves `import.meta.glob` keys relative to THIS file and collapses the
 * result, so the same target arrives under different prefixes depending on which
 * glob found it. `repoPathOf` resolves a key rather than matching its prefix, so
 * no shape here has to be enumerated — see its doc in `_gate-support.ts`.
 *
 * Only the KEYS are wanted — `eager: false` plus `?raw` keeps every entry a
 * lazy text import that nothing ever calls.
 *
 * The templates tree is reached through its **markdown**, not its `.ts`, and
 * that is load-bearing: knip resolves an `import.meta.glob` pattern whatever
 * its query, so a code glob here marks every template file as reached and knip
 * then reports `"templates/**"` in its `ignore` (and `@alexkroman1/aai-ui` in
 * `ignoreDependencies`) as removable. Those entries are what keep a template's
 * unused exports out of knip's report, so acting on that hint would hide real
 * findings — and a test about another gate's config should not reshape this
 * one's graph. Markdown is not a knip project file, so it carries no edge.
 * Every template path pattern in the config has its first placeholder at the
 * template-name segment, so one `.md` hit under `templates/` proves the whole
 * family's prefix.
 */
const repoFiles = Object.keys({
  ...import.meta.glob("../../../packages/*/src/*.{json,md}", { query: "?raw", eager: false }),
  // Source lives under `src/` now, so the shallow code sample starts there.
  ...import.meta.glob("../../../packages/*/src/*.{ts,tsx}", { query: "?raw", eager: false }),
  ...import.meta.glob("../../../packages/*/src/*/*.{ts,tsx}", { query: "?raw", eager: false }),
  // Both levels below `sdk/`, wildcarded rather than naming `providers/`: two
  // convention families live down there now (the four provider stages, and
  // `channels/`), and a glob naming one subtree by hand is the shape this very
  // test exists to catch — the next family would go unmeasured while the check
  // printed a pass. `*/*` reaches `sdk/channels/slack.ts`, `*/*/*` reaches
  // `sdk/providers/llm/anthropic.ts` — both now under `src/`.
  ...import.meta.glob("../../../packages/aai/src/sdk/*/*.ts", { query: "?raw", eager: false }),
  ...import.meta.glob("../../../packages/aai/src/sdk/*/*/*.ts", { query: "?raw", eager: false }),
  ...import.meta.glob("../templates/*/*.md", {
    query: "?raw",
    eager: false,
  }),
}).map(repoPathOf);

/**
 * Everything a `paths` pattern could select, FILES and DIRECTORIES both.
 *
 * `repoFiles` above is a shallow sample, which is all a literal-prefix check
 * needs; resolving a whole pattern needs the deep tree — `packages/aai/src/host/**`
 * and `packages/aai-ui/src/worklets/**` are three and two levels down, and two
 * conventions (`workspace-package-layout`, `agent-templates`) point at
 * DIRECTORIES, which no file glob returns. Directories are derived from every
 * ancestor of every file rather than globbed for.
 *
 * The pattern is the one `guard-invariants-gate.test.ts` already uses for its
 * own `repoFiles`, so no new module edge reaches the templates tree — see the
 * knip note above, which is about the SHALLOW globs and stays true of them.
 */
const repoPaths = (() => {
  // Two key shapes, exactly as the shallow globs above produce, and `repoPathOf`
  // is what knows them: Vite normalizes to the shortest relative form, so a
  // sibling package arrives as `../aai/index.ts` and THIS package's own files as
  // `./templates/…/agent.ts`.
  const files = Object.keys(import.meta.glob("../../*/**/*.{ts,tsx,json,md}")).map(repoPathOf);
  const paths = new Set(files);
  for (const file of files) {
    const segments = file.split("/");
    for (let i = segments.length - 1; i > 0; i--) paths.add(segments.slice(0, i).join("/"));
  }
  return paths;
})();

const config = JSON.parse(raw ?? "{}") as KonsistentConfig;

/**
 * A convention's predicate blocks, normalized to the array form.
 *
 * `must` accepts either one predicate object or a list of conditional blocks,
 * and a convention may carry a top-level `mustNot` instead of `must` entirely —
 * three shapes for one question ("what does this rule assert?").
 */
const blocksOf = (convention: Convention): MustBlock[] => {
  if (Array.isArray(convention.must)) return convention.must;
  const block: MustBlock = {};
  if (convention.must) block.must = convention.must;
  if (convention.mustNot) block.mustNot = convention.mustNot;
  return [block];
};

/**
 * A konsistent `paths` pattern as a regex over repo-relative paths.
 *
 * `{placeholder}` is konsistent's per-segment capture, `*` is a single segment
 * and `**` crosses them — the three kinds of magic these thirteen conventions
 * use. Leading `!` is stripped by the caller; polarity is not this function's
 * question.
 */
const patternToRegExp = (pattern: string): RegExp => {
  // The sentinels are spelled `\u0000` and NOT as raw NUL bytes. One literal
  // NUL makes the whole file BINARY to `git grep`, which silently exempts it
  // from every guard-invariants line rule and every check-escape-hatches
  // pattern — and the corpus floor cannot see it, because the file is still
  // present in `git ls-files`. That has now happened three times in this repo
  // (`host/workflow-notify.ts`, `host/workflow-keys.ts`, and here); the third
  // is what `assertScanCorpus`'s `git ls-files` vs `git grep -lI` diff now
  // catches. The escape is byte-identical at runtime.
  const body = pattern
    .replace(/^!/, "")
    // Escape everything a regex would read, EXCEPT the three magic forms.
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\{[A-Za-z0-9_]+\}/g, "\u0000SEG\u0000")
    .replace(/\*\*\//g, "\u0000DEEP\u0000")
    .replace(/\*\*/g, "\u0000ANY\u0000")
    .replace(/\*/g, "\u0000SEG\u0000")
    .replaceAll("\u0000SEG\u0000", "[^/]*")
    .replaceAll("\u0000DEEP\u0000", "(?:[^/]+/)*")
    .replaceAll("\u0000ANY\u0000", ".*");
  return new RegExp(`^${body}$`);
};

/** Literal path prefix of a glob — everything before the first magic character. */
const literalPrefix = (pattern: string): string => {
  const withoutNegation = pattern.replace(/^!/, "");
  const magic = withoutNegation.search(/[*{[?]/);
  const head = magic === -1 ? withoutNegation : withoutNegation.slice(0, magic);
  // Back up to the last complete path segment: "packages/aai/src/sdk/providers/llm/"
  // for ".../llm/{providerId}.ts".
  return head.slice(0, head.lastIndexOf("/") + 1);
};

describe("konsistent.json", () => {
  test("the config is present and declares v1 with the schema reference", () => {
    expect(raw, "konsistent.json not found at the repo root").toBeTypeOf("string");
    expect(config.version).toBe("v1");
    // The `$schema` line is what gives an editor autocomplete over the
    // predicate catalog; without it the next author is writing JSON blind.
    expect(config.$schema).toBe("node_modules/konsistent/konsistent.schema.json");
    expect(config.conventions.length).toBeGreaterThan(0);
  });

  test("every convention is named and says why it exists", () => {
    for (const [index, convention] of config.conventions.entries()) {
      const label = convention.name ?? `conventions[${index}]`;
      // The name is what a violation report prints, so an unnamed convention
      // fails as an anonymous `[?]` the reader cannot look up.
      expect(convention.name, `conventions[${index}] has no name`).toMatch(/^[a-z0-9-]+$/);
      // A structural rule without a rationale is the one a later author
      // deletes to make their branch pass.
      expect(convention.description, `${label} has no description`).toBeTypeOf("string");
      expect(convention.description?.length, `${label}'s description is too terse`).toBeGreaterThan(
        40,
      );
    }
  });

  test("convention names are unique", () => {
    const names = config.conventions.map((c) => c.name);
    expect(new Set(names).size, `duplicate convention name in ${names.join(", ")}`).toBe(
      names.length,
    );
  });

  test("every convention asserts something", () => {
    for (const convention of config.conventions) {
      const blocks = blocksOf(convention);
      expect(blocks.length, `${convention.name} has no must/mustNot blocks`).toBeGreaterThan(0);
      for (const block of blocks) {
        const predicates = { ...block.must, ...block.mustNot };
        // A block with `if`/`for` scoping and no predicates matches files and
        // checks nothing — the silent-pass shape this suite exists to catch.
        expect(
          Object.keys(predicates).length,
          `${convention.name}${block.name ? ` / ${block.name}` : ""} declares no predicates`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("every paths pattern points at a directory that exists", () => {
    // This is the typo that makes konsistent go quiet: `providers/llm` for
    // `providers/llm/`, `sdk/provider/` for `sdk/providers/`. The rule matches
    // zero files and reports zero violations, which reads exactly like a pass.
    for (const convention of config.conventions) {
      const patterns = Array.isArray(convention.paths) ? convention.paths : [convention.paths];
      for (const pattern of patterns) {
        const prefix = literalPrefix(pattern);
        if (prefix === "") continue; // Pattern is magic from the first segment.
        expect(
          repoFiles.some((file) => file.startsWith(prefix)),
          `${convention.name}: no file in the repo lives under "${prefix}" (from "${pattern}")`,
        ).toBe(true);
      }
    }
  });

  test("every paths pattern RESOLVES, not just its literal prefix", () => {
    // The prefix check above stops at the first magic character, so four of the
    // thirteen conventions reduce to `packages/` and a typo AFTER that point is
    // invisible to it: `*-barel.ts` for `*-barrel.ts` leaves the prefix intact,
    // makes konsistent check zero files, prints "No violations found", and
    // passes. It catches a directory-segment typo, which is the case its own
    // comment names, and nothing else.
    //
    // NEGATIONS are held to a different bar, and the asymmetry is the point. An
    // exclusion that matches nothing is harmless — it excludes nothing, and a
    // mistyped one fails LOUDLY, as konsistent flagging the file the exclusion
    // was meant to spare. Three of the twelve are legitimately inert today
    // (`stt`, `tts` and `s2s` hold no `*.test.ts`), so requiring them to resolve
    // would fail on the day somebody writes a provider test. What is worth
    // checking is that each one names a directory that exists.
    expect(repoPaths.size, "no repo paths discovered").toBeGreaterThan(800);
    for (const convention of config.conventions) {
      const patterns = Array.isArray(convention.paths) ? convention.paths : [convention.paths];
      for (const pattern of patterns) {
        if (pattern.startsWith("!")) {
          const parent = literalPrefix(pattern).replace(/\/$/, "");
          expect(
            repoPaths,
            `${convention.name}: exclusion "${pattern}" names "${parent}", which does not exist`,
          ).toContain(parent);
          continue;
        }
        const matcher = patternToRegExp(pattern);
        const matched = [...repoPaths].filter((path) => matcher.test(path));
        expect(
          matched.length,
          `${convention.name}: "${pattern}" selects NOTHING — konsistent would check zero ` +
            'files and print "No violations found"',
        ).toBeGreaterThan(0);
      }
    }
  });

  test("case-map entries are only there for names the defaults get wrong", () => {
    // The camel map is DERIVED from the pascal map when absent, so declaring
    // `openai: OpenAI` for the type names also makes the factory function
    // `openAILlm`. That derivation is wanted here — the identity entries that
    // used to suppress it (`openai: openai`, `openrouter: openrouter`) are
    // gone with the lowercase factory spellings they kept alive.
    for (const [kebab, pascal] of Object.entries(config.kebabToPascalMap ?? {})) {
      expect(kebab, `kebabToPascalMap key "${kebab}" is not kebab-case`).toMatch(/^[a-z0-9-]+$/);
      expect(pascal, `kebabToPascalMap["${kebab}"] is not PascalCase`).toMatch(/^[A-Z]/);
    }
    for (const kebab of Object.keys(config.kebabToCamelMap ?? {})) {
      expect(kebab, `kebabToCamelMap key "${kebab}" is not kebab-case`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("the gate is wired into the local check and CI, not just one of them", () => {
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:konsistent`).toContain("check:konsistent");
    }
  });
});
