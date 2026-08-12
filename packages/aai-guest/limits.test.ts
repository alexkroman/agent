// Copyright 2026 the AAI authors. MIT license.
// `limits.ts` is bundled into the guest and must therefore keep zero imports,
// so it cannot import the SDK constants it mirrors. These assertions are what
// stops the two sides drifting: they are the reason the duplication is safe.

import { STORAGE_DISABLED_MESSAGE } from "@alexkroman1/aai/internal";
import { TOOL_EXECUTION_TIMEOUT_MS } from "@alexkroman1/aai/limits";
import { describe, expect, test } from "vitest";
import * as limits from "./limits.ts";

describe("guest limits mirror the SDK constants", () => {
  test("tool execution timeout", () => {
    expect(limits.TOOL_TIMEOUT_MS).toBe(TOOL_EXECUTION_TIMEOUT_MS);
  });

  test("storage-disabled message", () => {
    // Dev (SDK tool-executor) and prod (guest harness) must throw the exact
    // same guidance when tool code touches ctx.db with storage off.
    expect(limits.STORAGE_DISABLED_MESSAGE).toBe(STORAGE_DISABLED_MESSAGE);
  });

  // The workspace caps are no longer mirrored — limits.ts re-exports the
  // SDK's, which the host's studio-limits.ts re-exports too, so the drift
  // this used to parse the host's source for cannot happen. Assert the shape
  // that replaced it: one definition, reachable from here.
  test("studio workspace caps come from the shared SDK contract", async () => {
    const shared = await import("@alexkroman1/aai/workspace-files");
    expect(limits.MAX_STUDIO_FILES).toBe(shared.MAX_WORKSPACE_FILES);
    expect(limits.MAX_STUDIO_FILE_BYTES).toBe(shared.MAX_WORKSPACE_FILE_BYTES);
  });

  test("orphan poll fires multiple times within one timeout window", () => {
    // The orphan check bounds detection latency; the poll must be able to
    // fire multiple times within one timeout window so the exit lands close
    // to the intended deadline rather than a whole poll late.
    expect(limits.HARNESS_ORPHAN_POLL_MS).toBeLessThanOrEqual(limits.HARNESS_ORPHAN_TIMEOUT_MS / 2);
  });

  test("limits.ts stays import-free so it can be bundled into the guest", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./limits.ts", import.meta.url), "utf8"),
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
