// Copyright 2025 the AAI authors. MIT license.
/**
 * The published surface of `@alexkroman1/aai-ui`.
 *
 * The `_`-prefixed rule mirrors `aai/sdk/exports.test.ts` — see there for the
 * `_internals` leak that motivated it, and for why the export SNAPSHOT this file
 * used to take is gone: `API-EXPORTS.json` and the capability epochs already pin
 * both subpaths' names, and a rule is the one claim neither can make.
 *
 * `./client-dir` is in the table because it is a real importable module
 * (`aai-cli`'s dev server resolves the prebuilt client through it), so a leak
 * there is still a leak.
 */

import { describe, expect, test } from "vitest";

const SUBPATH_IMPORTS: ReadonlyArray<readonly [label: string, load: () => Promise<object>]> = [
  ["@alexkroman1/aai-ui main", () => import("@alexkroman1/aai-ui")],
  ["@alexkroman1/aai-ui/client-dir", () => import("@alexkroman1/aai-ui/client-dir")],
];

// Each test body is a cold import of a whole barrel, and `sharedConfig`
// resolves the `@dev/source` condition — so this pulls the package's entire
// `.ts` graph (index, every component, session-core, audio, the worklets, React)
// through the transform pipeline. Nothing else in this suite imports the root
// barrel, so nothing warms it. Under a fully parallel turbo run that
// transform+load exceeds the 5s default timeout, so give these tests
// import-sized headroom — the same figure and the same reason as
// `aai/sdk/exports.test.ts`, which this file's `_`-prefix rule mirrors.
//
// Measured, because this was the repo's one flaky test before the headroom:
// 687ms running this file alone against 5009ms under a full `pnpm test`. It
// failed as a TIMEOUT, i.e. reported an export-surface violation when the export
// surface was fine. A `retry` would be the wrong instrument (see the root guide
// — a tier that retries has classified its own failures as noise): the
// assertion is deterministic and was simply never given time to compile a
// package.
const IMPORT_TIMEOUT_MS = 30_000;

describe("aai-ui export surface", { timeout: IMPORT_TIMEOUT_MS }, () => {
  test.each(SUBPATH_IMPORTS)("%s exports no underscore-prefixed name", async (_label, load) => {
    const leaked = Object.keys(await load()).filter((name) => name.startsWith("_"));
    expect(leaked, "`_`-prefixed names are package-internal — import the module directly").toEqual(
      [],
    );
  });
});
