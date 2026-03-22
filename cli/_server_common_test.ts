// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { resolveServerEnv } from "./_server_common.ts";

describe("resolveServerEnv", () => {
  test("returns env with existing ASSEMBLYAI_API_KEY", async () => {
    const env = await resolveServerEnv({ ASSEMBLYAI_API_KEY: "test-key-123" });
    expect(env.ASSEMBLYAI_API_KEY).toBe("test-key-123");
  });

  test("returned env contains all provided entries", async () => {
    const env = await resolveServerEnv({
      ASSEMBLYAI_API_KEY: "key",
      NODE_ENV: "test",
    });
    expect(env.NODE_ENV).toBe("test");
    expect(env.ASSEMBLYAI_API_KEY).toBe("key");
  });

  test("filters out undefined values", async () => {
    const env = await resolveServerEnv({
      ASSEMBLYAI_API_KEY: "key",
      MISSING: undefined,
    });
    expect(env).not.toHaveProperty("MISSING");
  });
});
