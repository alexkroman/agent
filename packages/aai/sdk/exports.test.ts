// Copyright 2025 the AAI authors. MIT license.
/**
 * Export surface snapshot tests for all five aai subpath exports.
 *
 * These tests catch accidental export additions or removals. If a snapshot
 * breaks, it signals a potentially breaking API change that should be
 * reviewed and documented with a changeset.
 */
import { describe, expect, test } from "vitest";

// Each test body is a cold import of an entire subpath barrel — the runtime
// barrel alone pulls in the full host module graph plus the provider SDKs
// (`ai`, `@ai-sdk/*`, `assemblyai`, ...). Under a fully parallel turbo run
// that transform+load can exceed the 5s default timeout, so give these
// tests import-sized headroom.
const IMPORT_TIMEOUT_MS = 30_000;

describe("export surface stability", { timeout: IMPORT_TIMEOUT_MS }, () => {
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

  test("@alexkroman1/aai/s2s export", async () => {
    const mod = await import("@alexkroman1/aai/s2s");
    expect(Object.keys(mod).sort()).toMatchSnapshot();
  });
});
