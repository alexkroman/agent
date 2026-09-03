#!/usr/bin/env node
// Copyright 2026 the AAI authors. MIT license.

/**
 * Reading a build input back out of the TypeScript that DECLARES it.
 *
 * Every ARG the guest Dockerfile takes has exactly one source of truth, and it is
 * a constant in `packages/aai-server/src/*.ts` — never a value restated in a script.
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
 * WHICH module declares each constant is {@link GUEST_IMAGE_CONSTANTS}, one table
 * rather than a `path.join(SERVER_DIR, …)` spelled at each of the five call sites
 * across three scripts. That spread is what made a constant MOVING expensive:
 * `GUEST_ROOT` left `modal-harness-image.ts` for `guest-exec-env.ts`, the old
 * module kept a re-export so every TypeScript import and the one spec that
 * imports them stayed green, and the only thing that noticed was `predev` failing
 * a developer's `pnpm dev:aai-server`.
 *
 * @module build-guest-image-extract
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVER_DIR = path.join(REPO_ROOT, "packages", "aai-server", "src");

export function read(file) {
  try {
    return readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`cannot read ${path.relative(REPO_ROOT, file)}`, { cause: err });
  }
}

/**
 * Pull one `const NAME = "value"` string out of a module, exported or not — the
 * `export` keyword is optional in the pattern because whether a constant is part
 * of the package's own surface is unrelated to whether the image build needs it.
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

/**
 * Every guest-image build input, and the `packages/aai-server` module that
 * DECLARES it — the one place a constant's home is written down.
 *
 * A re-export does not count and must not: these readers are regexes over source
 * text, so they see the `const`, never the name. That asymmetry is the whole
 * hazard — TypeScript follows a re-export and this does not, so a constant can
 * move with every import site and every spec still resolving it while the image
 * build stops resolving it at all. `guest-image-extractors.test.ts` is what
 * turns that into a red test: it resolves this table and compares each value
 * against the constant IMPORTED from TypeScript, so a move fails there rather
 * than in someone's `predev`.
 *
 * Keyed by the CONSTANT rather than by the Dockerfile ARG it feeds: `SDK_PACKAGES`
 * supplies `SDK_SPECS` only after version resolution, and one entry per declared
 * name is what the spec can iterate.
 */
export const GUEST_IMAGE_CONSTANTS = {
  DEFAULT_SANDBOX_IMAGE: { module: "modal-context.ts", kind: "string" },
  GUEST_ROOT: { module: "guest-exec-env.ts", kind: "string" },
  GUEST_SYSTEM_PACKAGES: { module: "modal-system-packages.ts", kind: "array" },
  SDK_PACKAGES: { module: "modal-harness-image.ts", kind: "array" },
};

/**
 * One declared build input, read out of the module {@link GUEST_IMAGE_CONSTANTS}
 * names.
 *
 * Throws on an undeclared name for the same reason the two readers throw on a
 * miss: a typo'd constant answering `undefined` would build an image on an empty
 * base or with no SDK, and neither is visible until a guest misbehaves.
 *
 * @param {keyof typeof GUEST_IMAGE_CONSTANTS | string} name
 * @returns {string | string[]}
 */
export function guestImageConstant(name) {
  const entry = GUEST_IMAGE_CONSTANTS[name];
  if (!entry) {
    throw new Error(
      `${name} is not a declared guest-image build input — add it to ` +
        "GUEST_IMAGE_CONSTANTS in scripts/build-guest-image-extract.mjs",
    );
  }
  const file = path.join(SERVER_DIR, entry.module);
  return entry.kind === "array" ? extractStringArray(file, name) : extractString(file, name);
}

/** {@link guestImageConstant}, narrowed to the string-valued inputs. */
export function guestImageString(name) {
  return String(guestImageConstant(name));
}

/** {@link guestImageConstant}, narrowed to the array-valued inputs. */
export function guestImageStringArray(name) {
  const value = guestImageConstant(name);
  if (!Array.isArray(value)) throw new Error(`${name} is not an array-valued build input`);
  return value;
}
