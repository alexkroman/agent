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
import { GATE_WIRING, repoPathOf, sole } from "./_gate-support.ts";

/**
 * Floors for the COMMITTED tree, deliberately looser than the script's floors
 * over a fresh render (12 files / 300 KB). This suite is asking "is the
 * artifact there at all", not re-measuring the render — the script already did
 * that against output it produced itself moments earlier.
 */
const MIN_COMMITTED_FILES = 10;
const MIN_COMMITTED_BYTES = 200_000;

const committed = import.meta.glob<string>("../../../docs/api/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

const markdownConfig = sole(
  import.meta.glob<string>("../../../docs/typedoc.markdown.json", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const siteConfig = import.meta.glob<string>("../../*/typedoc.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The manifests behind those configs, for the subpath-coverage assertion.
 *
 * Globbed rather than named, so a third package opting into the reference is
 * covered by the same assertion without an edit here.
 */
const packageManifests = import.meta.glob<string>("../../*/package.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const docsMarkdownScript = sole(
  import.meta.glob<string>("../../../scripts/docs-markdown.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

const markdownlintConfig = sole(
  import.meta.glob<string>("../../../.markdownlint-cli2.jsonc", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** Repo-relative paths of every committed markdown reference file. */
const committedPaths = Object.keys(committed).map(repoPathOf).sort();

/** Every `exports` key of a package's manifest whose target declares `types`. */
function typedSubpathsOf(pkg: string): { subpath: string; types: string }[] {
  const raw = packageManifests[`../../${pkg}/package.json`];
  if (raw === undefined) throw new Error(`no manifest for package ${pkg}`);
  const manifest = JSON.parse(raw) as {
    exports?: Record<string, unknown>;
  };
  return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
    // A string target ships an asset (`"./styles.css"`), not types. `?.` covers
    // the `typeof null === "object"` case without a second comparison.
    const types =
      typeof target === "object" ? (target as { types?: string } | null)?.types : undefined;
    return types ? [{ subpath, types }] : [];
  });
}

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
    const text = committed[`../../../${tts}`];
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

  test("documents every subpath those packages publish, or excuses it in writing", () => {
    // The rule `docs/CLAUDE.md` states and nothing enforced until
    // `docs-markdown.mjs` grew a check for it. This is the guard on the other
    // side, deriving the same fact INDEPENDENTLY — the script reads the
    // manifests and compares against the typedoc configs, so a manifest read
    // that stopped finding `exports` would compare nothing against nothing and
    // print its checkmark. Here the comparison is against the config TEXT.
    //
    // It also re-states the deny-list rather than reading it: an entry is a
    // decision with a paragraph attached, and the failure worth catching is
    // somebody adding one more to make a red gate green. `./testing/vite` is
    // the one that is not an internals subpath — it is BUILD tooling, a Vite
    // plugin a `vitest.config.ts` registers, so a reference page under the
    // authoring API would describe wiring rather than anything an author
    // writes.
    //
    // PER PACKAGE, because one package excuses its ROOT and the others must
    // not. `aai-runtime` is in the reference for `/eval`, `/eval/vitest` and
    // `/testing` — the surface whoever writes the `agent.ts` imports — and its
    // root barrel is the ~220-export embedder surface that stays out. A flat
    // list could not say that: a bare `"."` entry would excuse `@alexkroman1/aai`
    // itself going undocumented, which is the whole reference disappearing with
    // this gate still green.
    const denied: Record<string, readonly string[]> = {
      aai: ["./host-internal", "./internal", "./slugify", "./testing/vite", "./workspace-files"],
      "aai-ui": ["./internal"],
      "aai-runtime": [".", "./internal", "./tracing"],
    };
    const inspected = Object.entries(siteConfig).flatMap(([globKey, config]) => {
      const pkg = repoPathOf(globKey).split("/")[1];
      if (pkg === undefined) throw new Error(`unparsable glob key ${globKey}`);
      return typedSubpathsOf(pkg).map(({ subpath, types }) => {
        if (config.includes(`"${types.replace(/^\.\//, "")}"`)) return subpath;
        expect(
          denied[pkg] ?? [],
          `${pkg} publishes ${subpath} and documents it nowhere. Add the entry point, or ` +
            "deny-list it in scripts/docs-markdown.mjs with the reason.",
        ).toContain(subpath);
        expect(
          docsMarkdownScript,
          `scripts/docs-markdown.mjs does not name ${subpath} in UNDOCUMENTED_SUBPATHS`,
        ).toContain(`"${subpath}":`);
        return subpath;
      });
    }).length;
    // Floor, for the reason every count-only assertion here carries one: a
    // manifest glob that stopped resolving iterates zero subpaths and passes.
    // Measured actual: 27.
    expect(inspected).toBeGreaterThanOrEqual(20);
  });
});

describe("the gate is enforced", () => {
  test("check:docs-md is named by the local check and CI", () => {
    // Same reasoning as every other gate spec here: living only in check.mjs
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
