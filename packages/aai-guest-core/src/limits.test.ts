// Copyright 2026 the AAI authors. MIT license.
// `limits.ts` is bundled into the guest, so most of it MIRRORS the SDK
// constants rather than importing them. These assertions are what stops the
// two sides drifting: they are the reason the duplication is safe. The last
// test is the other half — what the file is allowed to depend on at all.

import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import * as limits from "./limits.ts";

describe("guest limits mirror the SDK constants", () => {
  test("no storage-disabled message, because there is no ctx.db", () => {
    // This pinned the guest's import-free DUPLICATE of the SDK's message against
    // the original, so dev and prod threw identically when tool code touched
    // `ctx.db` with storage off. Both are gone with the field: the platform hands
    // tool code no database. Asserted as an absence so a copy cannot come back
    // without its counterpart.
    expect("STORAGE_DISABLED_MESSAGE" in limits).toBe(false);
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

  test("limits.ts depends on nothing the guest bundle does not already carry", async () => {
    // The old form of this asserted `/^\s*import\s/m` — "zero imports" — and
    // could not see the one dependency the file actually has, because it
    // arrives as `export { … } from "@alexkroman1/aai/workspace-files"`. Both
    // the assertion and the module doc were false for as long as the caps were
    // re-exported, and a new `export … from "@alexkroman1/aai-cli/…"` (kept
    // EXTERNAL by the harness build) would have broken guest bundling with
    // this test green. Read every module specifier instead, whichever clause
    // carries it.
    const source = await readFile(new URL("./limits.ts", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );
    expect(specifiers.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "@alexkroman1/aai/internal",
      "@alexkroman1/aai/workspace-files",
    ]);
    // Belt and braces on the regex itself: a pattern that stopped matching
    // would report an empty list, which `toEqual` above would call a failure
    // only while the one real dependency exists.
    expect(source).toContain('from "@alexkroman1/aai/workspace-files"');
  });
});
