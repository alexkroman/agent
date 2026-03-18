// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { resolveServerEnv } from "./_server_common.ts";

describe("resolveServerEnv", () => {
  const origKey = process.env.ASSEMBLYAI_API_KEY;

  afterEach(() => {
    if (origKey !== undefined) {
      process.env.ASSEMBLYAI_API_KEY = origKey;
    } else {
      delete process.env.ASSEMBLYAI_API_KEY;
    }
  });

  test("returns env with existing ASSEMBLYAI_API_KEY", async () => {
    process.env.ASSEMBLYAI_API_KEY = "test-key-123";
    const env = await resolveServerEnv();
    expect(env.ASSEMBLYAI_API_KEY).toBe("test-key-123");
  });

  test("returned env contains process.env entries", async () => {
    process.env.ASSEMBLYAI_API_KEY = "key";
    process.env.NODE_ENV = "test";
    const env = await resolveServerEnv();
    expect(env.NODE_ENV).toBe("test");
  });
});
