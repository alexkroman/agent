// Copyright 2025 the AAI authors. MIT license.
/**
 * Export surface snapshot tests for all ten aai subpath exports.
 *
 * These tests catch accidental export additions or removals. If a snapshot
 * breaks, it signals a potentially breaking API change that should be
 * reviewed and documented with a changeset.
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
 * A table rather than ten copy-pasted tests, so adding a subpath export is
 * one line here instead of another duplicated body — the doc comment above
 * says "all ten", and this is what keeps that claim self-maintaining. The
 * loaders stay literal `import()` calls (not a computed specifier) so each
 * one remains statically resolvable.
 */
const SUBPATH_IMPORTS: ReadonlyArray<readonly [label: string, load: () => Promise<object>]> = [
  ["@alexkroman1/aai main", () => import("@alexkroman1/aai")],
  ["@alexkroman1/aai/utils", () => import("@alexkroman1/aai/utils")],
  ["@alexkroman1/aai/protocol", () => import("@alexkroman1/aai/protocol")],
  ["@alexkroman1/aai/manifest", () => import("@alexkroman1/aai/manifest")],
  ["@alexkroman1/aai/runtime", () => import("@alexkroman1/aai/runtime")],
  ["@alexkroman1/aai/s2s", () => import("@alexkroman1/aai/s2s")],
  ["@alexkroman1/aai/stt", () => import("@alexkroman1/aai/stt")],
  ["@alexkroman1/aai/tts", () => import("@alexkroman1/aai/tts")],
  ["@alexkroman1/aai/llm", () => import("@alexkroman1/aai/llm")],
  ["@alexkroman1/aai/tools", () => import("@alexkroman1/aai/tools")],
  // Published and importable, so a leak here is still a leak — being
  // "not public API, not semver-covered" is a promise to consumers, not a
  // reason to leave the surface unpinned.
  ["@alexkroman1/aai/internal", () => import("@alexkroman1/aai/internal")],
];

describe("export surface stability", { timeout: IMPORT_TIMEOUT_MS }, () => {
  test.each(SUBPATH_IMPORTS)("%s export", async (_label, load) => {
    expect(Object.keys(await load()).sort()).toMatchSnapshot();
  });

  // A RULE alongside the snapshots, because a snapshot absorbs whatever it is
  // shown the next time someone runs `-u`. `_internals` (s2s-transport's
  // connectS2s spy seam) rode the runtime barrel this way: a mutable object a
  // test patches, published as a process-wide behaviour switch on
  // `@alexkroman1/aai/runtime`, and the snapshot simply recorded it as normal.
  test.each(SUBPATH_IMPORTS)("%s exports no underscore-prefixed name", async (_label, load) => {
    const leaked = Object.keys(await load()).filter((name) => name.startsWith("_"));
    expect(leaked, "`_`-prefixed names are package-internal — import the module directly").toEqual(
      [],
    );
  });
});
