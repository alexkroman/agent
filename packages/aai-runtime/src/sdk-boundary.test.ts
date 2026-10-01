// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai-runtime`'s half of the SDK boundary gate (`aai/src/sdk/_boundary.ts`):
 * the runtime reaches a cross-copy slot or brand through the SDK's registry
 * (`globalSlot("name")`, the brand readers), never by spelling the key, so a
 * key has one definition both copies are built from.
 *
 * The runtime's OWN `Symbol.for` slots (two copies of `aai-runtime`, not of the
 * SDK) are a separate seam and not checked here.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOUNDARY_KEYS } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

const KEYS: string[] = [
  ...Object.values(BOUNDARY_KEYS.brands),
  ...Object.values(BOUNDARY_KEYS.slots),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test(-d)?\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

describe("the SDK boundary, from the runtime's side", () => {
  const files = sourceFiles(SRC);

  test("the scan sees the runtime", () => {
    expect(files).toContain(path.join(SRC, "inbox/event-feed.ts"));
  });

  test("no runtime source spells a key the SDK registry owns", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const key of KEYS) {
        if (text.includes(`"${key}"`)) offenders.push(`${path.relative(SRC, file)}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
