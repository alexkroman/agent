// Copyright 2025 the AAI authors. MIT license.
/**
 * The published surface of `@alexkroman1/aai-ui`.
 *
 * Only the main export was pinned; `./client-dir` is a real importable module
 * (`aai-cli`'s dev server resolves the prebuilt client through it) and had no
 * coverage at all. The `_`-prefixed rule mirrors `aai/sdk/exports.test.ts` —
 * see there for the `_internals` leak that motivated it: a snapshot records
 * whatever it is shown, so the rule has to be stated separately.
 */

import { describe, expect, test } from "vitest";

const SUBPATH_IMPORTS: ReadonlyArray<readonly [label: string, load: () => Promise<object>]> = [
  ["@alexkroman1/aai-ui main", () => import("@alexkroman1/aai-ui")],
  ["@alexkroman1/aai-ui/client-dir", () => import("@alexkroman1/aai-ui/client-dir")],
];

describe("aai-ui export surface", () => {
  test.each(SUBPATH_IMPORTS)("%s export", async (_label, load) => {
    expect(Object.keys(await load()).sort()).toMatchSnapshot();
  });

  test.each(SUBPATH_IMPORTS)("%s exports no underscore-prefixed name", async (_label, load) => {
    const leaked = Object.keys(await load()).filter((name) => name.startsWith("_"));
    expect(leaked, "`_`-prefixed names are package-internal — import the module directly").toEqual(
      [],
    );
  });
});
