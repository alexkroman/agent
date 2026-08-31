#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Reading a build input back out of the TypeScript that DECLARES it.
 *
 * Every ARG the guest Dockerfile takes has exactly one source of truth, and it is
 * a constant in `packages/aai-server/*.ts` — never a value restated in a script.
 * These two readers are how a plain `.mjs` gets at them without a TypeScript
 * loader, and `guest-image-dockerfile.test.ts` closes the loop from the other
 * side by IMPORTING the real constants and asserting these agree.
 *
 * Both THROW on a miss rather than returning a default. A regex read of source is
 * a liability wherever it can fail quietly: a silent miss builds an image on the
 * wrong base, or with no SDK, and neither is visible until a guest behaves
 * differently from production.
 *
 * Their own module because two scripts need them now — the builder and
 * `build-guest-image-sdk.mjs` — and the alternative was a circular import between
 * those two.
 *
 * @module build-guest-image-extract
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export function read(file) {
  try {
    return readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`cannot read ${path.relative(REPO_ROOT, file)}`, { cause: err });
  }
}

/**
 * Pull one `const NAME = "value"` string out of a module (exported or not:
 * SDK_PACKAGES is module-private while the other three are exported).
 *
 * Throws rather than returning a default: a silent miss here builds an image on
 * the wrong base, which is invisible until a guest behaves differently from
 * production.
 */
export function extractString(file, name) {
  const src = read(file);
  const match = new RegExp(`(?:export )?const ${name}\\s*=\\s*"([^"]+)"`).exec(src);
  if (!match) {
    throw new Error(
      `${name} is no longer declared as a string literal in ${path.relative(REPO_ROOT, file)} — ` +
        "update the extractor in scripts/build-guest-image.mjs",
    );
  }
  return match[1];
}

/** Pull one `export const NAME = [...] as const` string array out of a module. */
export function extractStringArray(file, name) {
  const src = read(file);
  const match = new RegExp(`(?:export )?const ${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!match) {
    throw new Error(
      `${name} is no longer declared as an array literal in ${path.relative(REPO_ROOT, file)} — ` +
        "update the extractor in scripts/build-guest-image.mjs",
    );
  }
  const items = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (items.length === 0) {
    throw new Error(`${name} in ${path.relative(REPO_ROOT, file)} parsed as empty`);
  }
  return items;
}
