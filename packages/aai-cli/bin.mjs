#!/usr/bin/env node
// The `aai` bin in BOTH layouts — the source checkout (`pnpm link --global`,
// where it loads `cli.ts` directly) and the published tarball (where only
// `dist/` ships, so it loads `dist/cli.mjs`). It used to be the dev bin only,
// with `publishConfig.bin` pointing straight at `dist/cli.mjs`.
//
// One bin for both is what makes the compile cache reachable. The cache only
// covers modules compiled AFTER the call, and every dependency of the CLI is
// external (`deps.neverBundle` in tsdown.config.ts), so `dist/cli.mjs` carries
// hoisted `import` statements for citty, execa and the rest — all evaluated
// before any statement in that file could run. A banner or a first-line call
// inside `cli.ts` would therefore cache nothing that costs anything. Loading
// the entry through a DYNAMIC import from a wrapper is the only ordering that
// puts the enable genuinely first.
import { existsSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { fileURLToPath } from "node:url";

// Caches V8 bytecode per (Node version, file content) under the user's cache
// dir, so `aai` pays parse+compile once per version rather than per
// invocation. Deliberately unguarded: this returns a `{ status }` result and
// does not throw, so an unwritable cache dir degrades to today's behaviour.
enableCompileCache();

// Source wins when present: a checkout that has also been built must keep
// running `cli.ts`, or `pnpm link --global` would silently serve a stale
// `dist/` instead of the working tree.
const source = new URL("./src/cli.ts", import.meta.url);
const entry = existsSync(fileURLToPath(source))
  ? source
  : new URL("./dist/cli.mjs", import.meta.url);
await import(entry.href);
