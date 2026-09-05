// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * What both `check-doc-examples.mjs` specs READ, and neither owns.
 *
 * `doc-examples-nocheck-gate.test.ts` and `doc-examples-ambient-gate.test.ts`
 * carried this byte-for-byte: the same five-glob markdown corpus, the same
 * `repoPathOf` normalization, the same `?raw` read of the gate script, and the
 * same `MARKDOWN_FILES` scrape — ~40 lines each, differing only in a trailing
 * `.sort(byCodeUnit)` and the wording of a comment. A document added to the
 * gate's list needed the corpus widened in BOTH files, and missing one narrowed
 * that spec silently, which is the exact failure both headers are about.
 *
 * It is a module of its own rather than a section of `_gate-support.ts` because
 * that one is imported by all 29 specs: an eager `?raw` corpus there would
 * inline this markdown into 29 workers to serve 2. The same reasoning keeps
 * each whole-repo tree glob in the spec that walks it.
 *
 * Reading and vocabulary only — no sample, no floor, no assertion. Each spec
 * still parses fences with its own parser and makes its own claims; a glob that
 * stopped resolving leaves {@link DOC_EXAMPLE_MARKDOWN} short and fails the
 * callers' own totality assertion by name.
 */

import { byCodeUnit, repoPathOf } from "./_gate-support.ts";

/** The gate whose declared corpus both specs re-derive. */
export const DOC_EXAMPLES_SCRIPT = "scripts/check-doc-examples.mjs";

/**
 * The gate's ENTRY POINT: the corpus lists and the fence parser live here.
 *
 * `import.meta.glob` is a compile-time transform, so the pattern has to be a
 * literal at the call site — which is why this is read HERE, once, and exported
 * as a value.
 */
export const docExamplesSource: string | undefined = Object.values(
  import.meta.glob<string>("../../../scripts/check-doc-examples.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0];

/**
 * Every markdown source the gate might read, by repo-relative path.
 *
 * Globbed WIDER than the gate's own list and intersected with it by the
 * callers: a literal pattern is what `import.meta.glob` requires, and reading
 * the list off the script is what makes "the gate stopped reading a document"
 * visible. Scoped to markdown rather than the doc-comment half because that is
 * where every directive in the corpus lives today, and because a `?raw` read of
 * one markdown file is one glob where the source trees are thousands.
 */
export const DOC_EXAMPLE_MARKDOWN: Record<string, string> = Object.fromEntries(
  Object.entries({
    ...import.meta.glob<string>("../../../README.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../../docs/home.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../*/README.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../../examples/*/README.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
    ...import.meta.glob<string>("../../aai-templates/scaffold/CLAUDE.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  }).map(([key, source]) => [repoPathOf(key), source]),
);

/**
 * The gate's own `MARKDOWN_FILES`, read as data rather than restated.
 *
 * THROWS when the declaration is gone, which is the load-bearing half: a reader
 * answering `[]` would turn a renamed constant into a corpus of nothing, and
 * every per-document assertion in both specs into a statement about it.
 *
 * Sorted, so a caller comparing its own corpus against this one is comparing
 * two lists in the same order.
 */
export function declaredMarkdown(): string[] {
  const block = /const MARKDOWN_FILES = \[([\s\S]*?)\];/.exec(docExamplesSource ?? "");
  if (block?.[1] === undefined)
    throw new Error(`${DOC_EXAMPLES_SCRIPT} no longer declares MARKDOWN_FILES`);
  return [...block[1].matchAll(/"([^"]+)"/g)]
    .map((found) => found[1])
    .filter((file): file is string => file !== undefined)
    .sort(byCodeUnit);
}
