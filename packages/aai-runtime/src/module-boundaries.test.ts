// Copyright 2026 the AAI authors. MIT license.
/**
 * A directory's `index.ts` is the ONLY module the rest of the package may
 * import from that directory.
 *
 * Inside a directory listed in {@link BOUNDED_DIRS}, "private" means "not
 * re-exported from the directory's `index.ts`" — there is no underscore prefix
 * to read. So the boundary has to be checked here, mechanically: a relative
 * import whose target sits inside a bounded directory that does NOT contain the
 * importer must name that directory's `index.ts`. When bounded directories nest
 * (`transports/pipeline/` holds `llm/`, `speech/`, …), the importer goes
 * through the OUTERMOST one it is not inside, so a module outside the pipeline
 * sees `transports/pipeline/index.ts` and nothing below it.
 *
 * Test-only files are exempt as IMPORTERS — a spec, a `_*-harness.ts` or a
 * `*-test-utils.ts` exists to reach a directory's internals, and widening a
 * production index for a test would make "not re-exported" mean nothing. They
 * are never exempt as TARGETS: production code cannot import a harness.
 *
 * The direction BETWEEN the pipeline's stages is konsistent's
 * `pipeline-stage-*` conventions, and that each `index.ts` is a pure re-export
 * surface is its `runtime-directory-index-barrels` — see
 * `transports/pipeline/CLAUDE.md`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

/** Directories whose `index.ts` is their whole surface, relative to `src/`. */
const BOUNDED_DIRS = [
  "s2s",
  "transports/pipeline",
  "transports/pipeline/heard",
  "transports/pipeline/history",
  "transports/pipeline/knobs",
  "transports/pipeline/llm",
  "transports/pipeline/output",
  "transports/pipeline/reply",
  "transports/pipeline/speech",
  "transports/pipeline/turn",
];

/** Test-only files: the specs and the scaffolding coverage also excludes. */
function isTestOnly(file: string): boolean {
  const base = path.posix.basename(file);
  return (
    /\.test(?:-d)?\.tsx?$/.test(base) ||
    /(?:^|\/)(?:integration|fixtures)\//.test(file) ||
    /^_test-utils\.ts$|-test-utils\.ts$|^_.*-setup\.ts$|^_mock-.*\.ts$|^_.*-fakes\.ts$|^_.*-harness\.ts$/.test(
      base,
    )
  );
}

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => /\.tsx?$/.test(entry) && !entry.includes("node_modules/"));
}

/** Every relative module specifier a file names, comments stripped. */
function relativeSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const specs: string[] = [];
  for (const match of code.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g,
  )) {
    specs.push(match[1] as string);
  }
  return specs;
}

const inside = (file: string, dir: string) => file.startsWith(`${dir}/`);

/** The outermost bounded directory that holds `target` and not `importer`. */
function boundaryFor(importer: string, target: string): string | undefined {
  return BOUNDED_DIRS.filter((dir) => inside(target, dir) && !inside(importer, dir)).sort(
    (a, b) => a.length - b.length,
  )[0];
}

/** Every production import that crosses into a bounded directory, and the bad ones. */
function scanBoundaries(files: readonly string[]): { crossings: number; violations: string[] } {
  let crossings = 0;
  const violations: string[] = [];
  for (const file of files) {
    if (isTestOnly(file)) continue;
    const source = readFileSync(path.join(SRC, file), "utf8");
    for (const spec of relativeSpecifiers(source)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      const dir = boundaryFor(file, target);
      if (dir === undefined) continue;
      crossings++;
      if (target !== `${dir}/index.ts`) {
        violations.push(`${file} imports ${spec} — import ${dir}/index.ts instead`);
      }
    }
  }
  return { crossings, violations };
}

describe("directory boundaries", () => {
  const files = sourceFiles();

  test("every bounded directory has an index.ts", () => {
    for (const dir of BOUNDED_DIRS) {
      expect(existsSync(path.join(SRC, dir, "index.ts")), dir).toBe(true);
    }
  });

  test("a module outside a bounded directory imports only its index.ts", () => {
    // Floors, so a scan that stops matching cannot pass by finding nothing.
    expect(files.length).toBeGreaterThan(300);
    const { crossings, violations } = scanBoundaries(files);
    expect(crossings).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  });
});
