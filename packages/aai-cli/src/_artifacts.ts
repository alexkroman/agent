// Copyright 2026 the AAI authors. MIT license.
/**
 * The `.aai/` layout — where `aai build` leaves what `aai start` and the
 * deployment targets read back.
 *
 * A LEAF module, and that is the whole reason it exists. These two paths were
 * declared where they were first needed (`build.ts`, `start.ts`), which was
 * fine while the readers were the writers. `_vercel-output.ts` needs both and
 * is imported BY `build.ts`, so taking them from there is an import cycle —
 * one Biome rejects, and one that would fail at runtime rather than at build
 * time, since a `const` read across a cycle is a `ReferenceError` decided by
 * import order. Both original homes re-export, so no published subpath moved.
 */

import path from "node:path";

/** Where `aai build` leaves the worker bundle, relative to the project root. */
export const WORKER_ARTIFACT_REL = path.join(".aai", "worker.mjs");

/** Where `aai build` leaves the built browser client, relative to the root. */
export const CLIENT_ARTIFACT_REL = path.join(".aai", "client");
