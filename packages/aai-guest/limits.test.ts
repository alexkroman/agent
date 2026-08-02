// Copyright 2026 the AAI authors. MIT license.
// `limits.ts` is bundled into the guest and must therefore keep zero imports,
// so it cannot import the SDK constants it mirrors. These assertions are what
// stops the two sides drifting: they are the reason the duplication is safe.

import { STORAGE_DISABLED_MESSAGE, TOOL_EXECUTION_TIMEOUT_MS } from "@alexkroman1/aai";
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

  // limits.ts claims these mirror aai-studio-server's studio-limits.ts with
  // "the same asserted-not-imported arrangement" — but nothing asserted them.
  // Drift is silent in both directions: the guest truncates its end-of-turn
  // sync at its own cap while the host validates the arriving payload against
  // its own, so either files vanish or the whole sync is rejected and the
  // user's turn looks like it wrote nothing.
  // Read as SOURCE rather than imported: the guest must not take a dependency
  // on server code (the boundary this package exists to enforce), so the
  // assertion parses the host's constants out of the file instead.
  test("studio workspace caps match the host's", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../aai-studio-server/studio-limits.ts", import.meta.url),
      "utf8",
    );
    const hostValue = (name: string): number => {
      const match = new RegExp(`${name}\\s*=\\s*([0-9_]+)`).exec(source);
      if (!match?.[1]) throw new Error(`${name} not found in studio-limits.ts`);
      return Number(match[1].replaceAll("_", ""));
    };
    expect(limits.MAX_STUDIO_FILES).toBe(hostValue("MAX_STUDIO_FILES"));
    expect(limits.MAX_STUDIO_FILE_BYTES).toBe(hostValue("MAX_STUDIO_FILE_BYTES"));
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
