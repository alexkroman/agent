// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * The guard under `pnpm check:docs-md`.
 *
 * That gate renders the markdown API reference into a temp directory and
 * compares it against the committed `docs/api/`. Two things it derives, two
 * things it compares — so an extraction that stopped producing anything would
 * find an empty render agreeing with an empty tree and print
 * "docs/api/ is current — 0 file(s) ✓". Same shape as the five count-only
 * gates AGENTS.md records having caught doing exactly that.
 *
 * The script's own floor is the primary defence and it runs on the FRESH
 * render. This suite covers what the floor cannot see, because it reads the
 * COMMITTED tree and the config that produced it:
 *
 * - the committed reference is present and substantial, so a `docs/api/`
 *   deleted or gitignored is a failure here rather than a gate that regenerates
 *   it into nothing and agrees with itself;
 * - every entry point the SITE documents has a committed markdown file, which
 *   is the drift the shared `extends` exists to prevent and the only assertion
 *   that would notice `extends` silently resolving to nothing;
 * - the markdown config still declares the plugin and the module-per-file
 *   strategy, since losing either changes the artifact into something with the
 *   same name and a different shape;
 * - the gate is named in all three wiring files, and the generated tree is
 *   excluded from markdownlint.
 *
 * It lives in aai-templates for the reason the other gate specs do: this
 * package owns the documentation artifacts, and raw imports reach repo-root
 * files with no node types, which this package's tsconfig does not have.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, repoPathOf } from "./_gate-support.ts";

/**
 * Floors for the COMMITTED tree, deliberately looser than the script's floors
 * over a fresh render (12 files / 300 KB). This suite is asking "is the
 * artifact there at all", not re-measuring the render — the script already did
 * that against output it produced itself moments earlier.
 */
const MIN_COMMITTED_FILES = 10;
const MIN_COMMITTED_BYTES = 200_000;

const committed = import.meta.glob<string>("../../docs/api/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const markdownConfig = import.meta.glob<string>("../../docs/typedoc.markdown.json", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../docs/typedoc.markdown.json"];

const siteConfig = import.meta.glob<string>("../*/typedoc.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const markdownlintConfig = import.meta.glob<string>("../../.markdownlint-cli2.jsonc", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../.markdownlint-cli2.jsonc"];

/** Repo-relative paths of every committed markdown reference file. */
const committedPaths = Object.keys(committed).map(repoPathOf).sort();

describe("the committed markdown API reference", () => {
  test("exists and is substantial", () => {
    // A glob that resolves to nothing is the failure this whole suite exists
    // for: the gate would regenerate, find nothing to compare, and pass.
    expect(committedPaths.length).toBeGreaterThanOrEqual(MIN_COMMITTED_FILES);
    const bytes = Object.values(committed).reduce((sum, text) => sum + text.length, 0);
    expect(bytes).toBeGreaterThanOrEqual(MIN_COMMITTED_BYTES);
  });

  test("carries prose, not just signatures", () => {
    // The whole reason this artifact exists beside API.md: the reports strip
    // every doc comment, and those comments are what a reader needs. If the
    // config ever lost them the files would still be here, still diff clean,
    // and worth nothing.
    const tts = committedPaths.find((path) => path.endsWith("/tts.md"));
    expect(tts, `no tts.md among ${committedPaths.join(", ")}`).toBeTypeOf("string");
    const text = committed[`../../${tts}`];
    expect(text).toContain("subpath barrel");
  });

  test("names files by published subpath, not by emitted .d.ts path", () => {
    // Both of these were `sdk/workflow-api-barrel.md` and `host/ffmpeg.md`
    // until their entry modules gained an `@module` tag — i.e. named after the
    // file TypeDoc read rather than the specifier a consumer imports. A reader
    // looking for `@alexkroman1/aai/ffmpeg` has no reason to guess `host/`.
    for (const subpath of ["ffmpeg", "workflow-api", "tts", "stt", "llm", "s2s"]) {
      expect(
        committedPaths.some((path) => path.endsWith(`/${subpath}.md`)),
        `no committed file for the ${subpath} subpath`,
      ).toBe(true);
    }
    expect(committedPaths.some((path) => path.includes("-barrel.md"))).toBe(false);
  });
});

describe("the markdown config", () => {
  test("shares its entry points with the site config", () => {
    // `extends` is the only thing stopping a new subpath export from reaching
    // the rendered site and silently missing this artifact. It is one line and
    // deleting it breaks nothing visibly.
    expect(markdownConfig, "docs/typedoc.markdown.json not found").toBeTypeOf("string");
    expect(markdownConfig).toContain('"extends": "./typedoc.json"');
  });

  test("still loads the markdown plugin and renders one file per module", () => {
    // Without the plugin typedoc emits HTML into docs/api/ and the gate happily
    // diffs it; without `modules` the plugin emits ~700 files, one per symbol.
    // Either produces an artifact with this one's name and none of its shape.
    expect(markdownConfig).toContain("typedoc-plugin-markdown");
    expect(markdownConfig).toContain('"outputFileStrategy": "modules"');
  });

  test("documents every package the site does", () => {
    // Reads the sibling typedoc.json files rather than the docs/ one, so this
    // notices a package whose entry points exist and whose markdown never
    // rendered — the failure `extends` cannot catch by itself.
    const documented = Object.keys(siteConfig).map(repoPathOf);
    expect(documented.length).toBeGreaterThanOrEqual(2);
    for (const path of documented) {
      const pkg = path.split("/")[1];
      expect(
        committedPaths.some((committedPath) => committedPath.includes(`/${pkg}`)),
        `${pkg} has a typedoc.json but no committed markdown under docs/api/`,
      ).toBe(true);
    }
  });
});

describe("the gate is enforced", () => {
  test("check:docs-md is named by the local check and CI", () => {
    // Same reasoning as every other gate spec here: living only in check.sh
    // means enforcement by the pre-push hook alone, which `--no-verify` skips.
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect(text, `${path} not found`).toBeTypeOf("string");
      expect(text, `${path} no longer references check:docs-md`).toContain("check:docs-md");
    }
  });

  test("the generated tree is excluded from markdownlint", () => {
    // Generated markdown cannot be style-fixed: the next render reverts it. The
    // repo already ignores API.md and the etc/ reports on the same grounds.
    expect(markdownlintConfig, ".markdownlint-cli2.jsonc not found").toBeTypeOf("string");
    expect(markdownlintConfig).toContain('"docs/api/**"');
  });
});
