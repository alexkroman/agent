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
 * glob (`packages/aai/sdk/provider/` for `providers/`) silently checks zero
 * files and prints the same "No violations found" as a healthy run, and unlike
 * a broken lint rule there is no error anywhere to notice. So the tests here
 * assert the config's SHAPE — that each convention is named, described, and
 * points at paths that exist — rather than trusting a green run.
 *
 * The wiring test is the other half. The quality ratchets lived only in
 * `scripts/check.sh` for a long time, which CI never invokes, so
 * `git push --no-verify` skipped them entirely; a new gate has to be in both
 * places or it is enforced by a hook the author can bypass.
 *
 * This lives in aai-templates for the same reason `claude-md-limit.test.ts`
 * and `test-assertion-gate.test.ts` do: it is the package that owns
 * repo-level meta checks, and `?raw` imports reach repo-root files without
 * node types, which this package's tsconfig has none of.
 */

import { describe, expect, test } from "vitest";

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

const raw = import.meta.glob("../../konsistent.json", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../konsistent.json"] as string | undefined;

/**
 * Repo-relative paths of everything a convention could plausibly point at, so a
 * glob typo has something concrete to fail against.
 *
 * Vite resolves `import.meta.glob` keys relative to THIS file and collapses the
 * result, so the keys arrive in two shapes: `../aai/index.ts` for a sibling
 * package (one level up from `packages/aai-templates/` is `packages/`) and
 * `./templates/simple/system-prompt.md` for this package's own files.
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
  ...import.meta.glob("../../packages/*/*.{ts,tsx,json,md}", { query: "?raw", eager: false }),
  ...import.meta.glob("../../packages/*/*/*.{ts,tsx}", { query: "?raw", eager: false }),
  ...import.meta.glob("../../packages/aai/sdk/providers/*/*.ts", { query: "?raw", eager: false }),
  ...import.meta.glob("../../packages/aai-templates/templates/*/*.md", {
    query: "?raw",
    eager: false,
  }),
}).map((key) =>
  key.startsWith("../")
    ? `packages/${key.slice("../".length)}`
    : `packages/aai-templates/${key.replace(/^\.\//, "")}`,
);

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

/** Literal path prefix of a glob — everything before the first magic character. */
const literalPrefix = (pattern: string): string => {
  const withoutNegation = pattern.replace(/^!/, "");
  const magic = withoutNegation.search(/[*{[?]/);
  const head = magic === -1 ? withoutNegation : withoutNegation.slice(0, magic);
  // Back up to the last complete path segment: "packages/aai/sdk/providers/llm/"
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

  test("case-map entries are only there for names the defaults get wrong", () => {
    // An identity entry in kebabToCamelMap looks redundant and is not: the
    // camel map is DERIVED from the pascal map when absent, so declaring
    // `openai: OpenAI` for the type names silently turns the factory function
    // into `openAI`. The identity entry is what keeps `openai()` correct.
    for (const [kebab, pascal] of Object.entries(config.kebabToPascalMap ?? {})) {
      expect(kebab, `kebabToPascalMap key "${kebab}" is not kebab-case`).toMatch(/^[a-z0-9-]+$/);
      expect(pascal, `kebabToPascalMap["${kebab}"] is not PascalCase`).toMatch(/^[A-Z]/);
    }
    for (const kebab of Object.keys(config.kebabToCamelMap ?? {})) {
      expect(kebab, `kebabToCamelMap key "${kebab}" is not kebab-case`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("the gate is wired into the local check and CI, not just one of them", () => {
    const files: Record<string, string | undefined> = {
      "package.json": import.meta.glob("../../package.json", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../package.json"],
      "scripts/check.sh": import.meta.glob("../../scripts/check.sh", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../scripts/check.sh"],
      ".github/workflows/check.yml": import.meta.glob("../../.github/workflows/check.yml", {
        query: "?raw",
        import: "default",
        eager: true,
      })["../../.github/workflows/check.yml"],
    };
    for (const [path, text] of Object.entries(files)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:konsistent`).toContain("check:konsistent");
    }
  });
});
