// Copyright 2025 the AAI authors. MIT license.
/**
 * Export surface snapshot tests for all four aai subpath exports.
 *
 * These tests catch accidental export additions or removals. If a snapshot
 * breaks, it signals a potentially breaking API change that should be
 * reviewed and documented with a changeset.
 */
import { describe, expect, test } from "vitest";

describe("export surface stability", () => {
  test("@alexkroman1/aai main export", async () => {
    const mod = await import("@alexkroman1/aai");
    expect(Object.keys(mod).sort()).toMatchSnapshot();
  });

  test("@alexkroman1/aai/protocol export", async () => {
    const mod = await import("@alexkroman1/aai/protocol");
    expect(Object.keys(mod).sort()).toMatchSnapshot();
  });

  test("@alexkroman1/aai/manifest export", async () => {
    const mod = await import("@alexkroman1/aai/manifest");
    expect(Object.keys(mod).sort()).toMatchSnapshot();
  });

  test("@alexkroman1/aai/runtime export", async () => {
    const mod = await import("@alexkroman1/aai/runtime");
    expect(Object.keys(mod).sort()).toMatchSnapshot();
  });
});
