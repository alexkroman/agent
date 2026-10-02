// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `defaultClientDir()`, the path a server hands `clientDir`.
 *
 * Only the resolution is asserted, never the directory's contents: whether
 * `dist/default-client/` has been BUILT is the build's business, and a unit
 * spec that required it would fail on a fresh checkout for a reason that has
 * nothing to do with this module.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { defaultClientDir } from "./client-dir.ts";

describe("defaultClientDir", () => {
  test("is the prebuilt client under THIS package's own dist", () => {
    const dir = defaultClientDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(path.basename(dir)).toBe("default-client");
    expect(path.basename(path.dirname(dir))).toBe("dist");

    // Resolved through the package's own manifest, so the root it hangs off is
    // the aai-ui package whichever entry (source or dist) the caller loaded.
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "..", "..", "package.json"), "utf8"),
    ) as { name?: string };
    expect(manifest.name).toBe("@alexkroman1/aai-ui");
  });

  test("is a function of nothing, so two calls agree", () => {
    expect(defaultClientDir()).toBe(defaultClientDir());
  });
});
