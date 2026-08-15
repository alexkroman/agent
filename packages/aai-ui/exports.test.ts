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

describe("aai-ui export surface", () => {
  test.each(SUBPATH_IMPORTS)("%s exports no underscore-prefixed name", async (_label, load) => {
    const leaked = Object.keys(await load()).filter((name) => name.startsWith("_"));
    expect(leaked, "`_`-prefixed names are package-internal — import the module directly").toEqual(
      [],
    );
  });
});
