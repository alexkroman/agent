// Copyright 2025 the AAI authors. MIT license.
/**
 * Two claims about every aai subpath export that no static report can make.
 *
 * It used to snapshot each barrel's key list as well, and that half is gone:
 * `API-EXPORTS.json` records the same names for every published subpath
 * (measured — every runtime name was already covered, with zero gaps), the
 * `etc/*.api.md` reports record their signatures, and the capability epochs
 * classify a break. Three pins on one surface is worse than one, because the
 * weakest is the copy that gets updated when they disagree — and a test whose
 * whole content is "the surface is what it was" trains everyone to reach for
 * `-u`.
 *
 * What is left is what those gates cannot see:
 *
 * - **The `_`-prefix RULE.** `check:api-report` is a staleness gate: it fails when
 *   the committed report disagrees with the tree and says nothing about content,
 *   so it would silently RECORD a leaked `_internals` the first time one was
 *   committed. This is the only thing standing between the repo and a second one.
 * - **The cold import.** Each case loads a whole subpath barrel, so a circular
 *   import that leaves a name `undefined` at load time fails here. A report
 *   derived from `dist/*.d.ts` cannot see that at all.
 *
 * Both are worth exactly as much as the table below is COMPLETE, and for a long
 * time it was not: it listed 15 of the 19 published subpaths while describing
 * itself as every one of them, so `./step`, `./testing/vitest`, `./slugify` and
 * `./host-internal` — the largest entry point in the repo — were covered by
 * neither claim. A hand-kept list of the public surface is the thing this repo
 * keeps discovering has gone stale, so the completeness is a TEST now (see
 * "the table covers every published subpath" below) rather than a sentence in
 * this comment.
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

// Each test body is a cold import of an entire subpath barrel — the runtime
// barrel alone pulls in the full host module graph plus the provider SDKs
// (`ai`, `@ai-sdk/*`, `assemblyai`, ...). Under a fully parallel turbo run
// that transform+load can exceed the 5s default timeout, so give these
// tests import-sized headroom.
const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Every published subpath, paired with a loader.
 *
 * A table rather than 19 copy-pasted tests, so adding a subpath export is one
 * line here instead of another duplicated body. The loaders stay literal
 * `import()` calls (not a computed specifier) so each one remains statically
 * resolvable — which is why the table is checked against `package.json`
 * instead of being generated from it.
 *
 * Four of these are published and importable while being explicitly outside
 * the semver-covered surface — `./internal`, `./host-internal`,
 * `./workspace-files` and `./slugify`. That is a promise to consumers about
 * what the names MEAN, not a reason to leave the surface unpinned: a leak here
 * is still a leak.
 */
const SUBPATH_IMPORTS: ReadonlyArray<{
  readonly subpath: string;
  readonly load: () => Promise<object>;
}> = [
  { subpath: ".", load: () => import("@alexkroman1/aai") },
  { subpath: "./utils", load: () => import("@alexkroman1/aai/utils") },
  { subpath: "./step", load: () => import("@alexkroman1/aai/step") },
  { subpath: "./testing", load: () => import("@alexkroman1/aai/testing") },
  { subpath: "./testing/vitest", load: () => import("@alexkroman1/aai/testing/vitest") },
  { subpath: "./testing/vite", load: () => import("@alexkroman1/aai/testing/vite") },
  { subpath: "./channels", load: () => import("@alexkroman1/aai/channels") },
  { subpath: "./step-errors", load: () => import("@alexkroman1/aai/step-errors") },
  { subpath: "./step-files", load: () => import("@alexkroman1/aai/step-files") },
  { subpath: "./workflow-api", load: () => import("@alexkroman1/aai/workflow-api") },
  { subpath: "./protocol", load: () => import("@alexkroman1/aai/protocol") },
  { subpath: "./workspace-files", load: () => import("@alexkroman1/aai/workspace-files") },
  { subpath: "./slugify", load: () => import("@alexkroman1/aai/slugify") },
  { subpath: "./manifest", load: () => import("@alexkroman1/aai/manifest") },
  { subpath: "./stt", load: () => import("@alexkroman1/aai/stt") },
  { subpath: "./tts", load: () => import("@alexkroman1/aai/tts") },
  { subpath: "./llm", load: () => import("@alexkroman1/aai/llm") },
  { subpath: "./s2s", load: () => import("@alexkroman1/aai/s2s") },
  { subpath: "./ffmpeg", load: () => import("@alexkroman1/aai/ffmpeg") },
  { subpath: "./html", load: () => import("@alexkroman1/aai/html") },
  { subpath: "./tools", load: () => import("@alexkroman1/aai/tools") },
  { subpath: "./internal", load: () => import("@alexkroman1/aai/internal") },
  { subpath: "./host-internal", load: () => import("@alexkroman1/aai/host-internal") },
];

/** The subpaths `package.json` actually publishes — the set the table must equal. */
function publishedSubpaths(): string[] {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const exportsField = (manifest as { exports?: Record<string, unknown> }).exports;
  return Object.keys(exportsField ?? {}).sort();
}

describe("export surface stability", { timeout: IMPORT_TIMEOUT_MS }, () => {
  // A RULE rather than a record, because a record absorbs whatever it is shown.
  // `_internals` (s2s-transport's connectS2s spy seam) rode the runtime barrel
  // this way: a mutable object a test patches, published as a process-wide
  // behaviour switch on `@alexkroman1/aai-runtime`, and the export snapshot that
  // used to live here simply recorded it as normal.
  test.each(SUBPATH_IMPORTS)(
    "@alexkroman1/aai $subpath exports no underscore-prefixed name",
    async ({ load }) => {
      const leaked = Object.keys(await load()).filter((name) => name.startsWith("_"));
      expect(
        leaked,
        "`_`-prefixed names are package-internal — import the module directly",
      ).toEqual([]);
    },
  );

  // DERIVED, not listed: the table above is the only hand-kept copy of the
  // published surface left in this file, and the one before it silently sat at
  // 15 of 19 for long enough that its own doc comment said "every published
  // subpath" and was wrong. A new subpath export now fails here until it is
  // covered by the two claims above, which is the same moment it becomes
  // something a consumer can import.
  test("the table covers every published subpath", () => {
    const covered = SUBPATH_IMPORTS.map((entry) => entry.subpath).sort();
    expect(covered, "add the new subpath to SUBPATH_IMPORTS, with a literal import()").toEqual(
      publishedSubpaths(),
    );
  });
});
