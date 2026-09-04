// Copyright 2026 the AAI authors. MIT license.
/**
 * The `.aai/` layout, and the RE-EXPORTS that keep it one declaration.
 *
 * Both paths were declared where they were first needed and are now published
 * from a leaf module, because `_vercel-output.ts` needs both and is imported by
 * `build.ts` — taking them from there was an import cycle. What this asserts is
 * the property that made the move safe: each original home re-exports, so no
 * published subpath moved and no consumer had to change.
 *
 * A cycle would not have failed a test, either. It fails at RUNTIME, as a
 * `ReferenceError` decided by import order, which is why the fix is structural
 * rather than a comment asking the next author not to.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { WORKER_ARTIFACT_REL as fromBuild } from "./build.ts";
import { CLIENT_ARTIFACT_REL as fromStart } from "./start.ts";

describe("the .aai layout", () => {
  test("both artifacts live under .aai, in a platform-correct path", () => {
    // `path.join`, not a literal: these are compared against real paths on
    // Windows too, where a "/" spelling silently matches nothing.
    expect(WORKER_ARTIFACT_REL).toBe(path.join(".aai", "worker.mjs"));
    expect(CLIENT_ARTIFACT_REL).toBe(path.join(".aai", "client"));
  });

  test("the original homes re-export, so nothing published moved", () => {
    // `aai build` publishes `WORKER_ARTIFACT_REL` from `./build` and `aai start`
    // publishes `CLIENT_ARTIFACT_REL` from `./start` (see each package's
    // `etc/*.api.md`). Same VALUE, not merely the same shape — a second
    // declaration would satisfy a shape assertion and drift.
    expect(fromBuild).toBe(WORKER_ARTIFACT_REL);
    expect(fromStart).toBe(CLIENT_ARTIFACT_REL);
  });
});
