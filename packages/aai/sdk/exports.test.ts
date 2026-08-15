// Copyright 2025 the AAI authors. MIT license.
/**
 * Two claims about every aai subpath export that no static report can make.
 *
 * It used to snapshot each barrel's key list as well, and that half is gone:
 * `API-EXPORTS.json` records the same names for all 15 subpaths (measured — every
 * runtime name was already covered, with zero gaps), the `etc/*.api.md` reports
 * record their signatures, and the capability epochs classify a break. Three pins
 * on one surface is worse than one, because the weakest is the copy that gets
 * updated when they disagree — and a test whose whole content is "the surface is
 * what it was" trains everyone to reach for `-u`.
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
 */
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
 * A table rather than 15 copy-pasted tests, so adding a subpath export is one
 * line here instead of another duplicated body. The loaders stay literal
 * `import()` calls (not a computed specifier) so each one remains statically
 * resolvable.
 */
const SUBPATH_IMPORTS: ReadonlyArray<readonly [label: string, load: () => Promise<object>]> = [
  ["@alexkroman1/aai main", () => import("@alexkroman1/aai")],
  ["@alexkroman1/aai/utils", () => import("@alexkroman1/aai/utils")],
  ["@alexkroman1/aai/testing", () => import("@alexkroman1/aai/testing")],
  ["@alexkroman1/aai/step-errors", () => import("@alexkroman1/aai/step-errors")],
  ["@alexkroman1/aai/protocol", () => import("@alexkroman1/aai/protocol")],
  ["@alexkroman1/aai/manifest", () => import("@alexkroman1/aai/manifest")],
  ["@alexkroman1/aai/runtime", () => import("@alexkroman1/aai/runtime")],
  ["@alexkroman1/aai/s2s", () => import("@alexkroman1/aai/s2s")],
  ["@alexkroman1/aai/stt", () => import("@alexkroman1/aai/stt")],
  ["@alexkroman1/aai/tts", () => import("@alexkroman1/aai/tts")],
  ["@alexkroman1/aai/llm", () => import("@alexkroman1/aai/llm")],
  ["@alexkroman1/aai/tools", () => import("@alexkroman1/aai/tools")],
  ["@alexkroman1/aai/workflow-api", () => import("@alexkroman1/aai/workflow-api")],
  // Published and importable, so a leak here is still a leak — being
  // "not public API, not semver-covered" is a promise to consumers, not a
  // reason to leave the surface unpinned. Same for `/workspace-files`, which
  // exists for the workspace packages (CLI push, guest sync, platform
  // validation) rather than for SDK users.
  ["@alexkroman1/aai/internal", () => import("@alexkroman1/aai/internal")],
  ["@alexkroman1/aai/workspace-files", () => import("@alexkroman1/aai/workspace-files")],
];

describe("export surface stability", { timeout: IMPORT_TIMEOUT_MS }, () => {
  // A RULE rather than a record, because a record absorbs whatever it is shown.
  // `_internals` (s2s-transport's connectS2s spy seam) rode the runtime barrel
  // this way: a mutable object a test patches, published as a process-wide
  // behaviour switch on `@alexkroman1/aai/runtime`, and the export snapshot that
  // used to live here simply recorded it as normal.
  test.each(SUBPATH_IMPORTS)("%s exports no underscore-prefixed name", async (_label, load) => {
    const leaked = Object.keys(await load()).filter((name) => name.startsWith("_"));
    expect(leaked, "`_`-prefixed names are package-internal — import the module directly").toEqual(
      [],
    );
  });
});
