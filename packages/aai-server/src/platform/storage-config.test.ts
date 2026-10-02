// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { captureLogs } from "../_logger-test-utils.ts";
import { assertStorageBucket, buildStorage, buildUploadBytes } from "./storage-config.ts";

describe("storage config", () => {
  const logs = captureLogs();

  test("with no platform database, both stores are in memory, and say so", async () => {
    const blobs = buildStorage({});
    await blobs.setItem("k", "v");
    expect(await blobs.getItem("k")).toBe("v");
    expect(buildUploadBytes({})).toBeDefined();
    expect(logs.infos()).toHaveLength(2);
  });

  test("with no platform database there is no bucket to check", async () => {
    await expect(assertStorageBucket({})).resolves.toBeUndefined();
  });

  test("a platform database without the Supabase trio fails loudly, naming what is missing", () => {
    const env = { SUPABASE_DB_URL: "postgres://db.test/postgres" };
    for (const build of [buildStorage, buildUploadBytes]) {
      expect(() => build(env)).toThrow(
        /SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET/,
      );
    }
  });

  test("a partial trio names only the missing key", async () => {
    const env = {
      SUPABASE_DB_URL: "postgres://db.test/postgres",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };
    await expect(assertStorageBucket(env)).rejects.toThrow(
      "Missing required environment variables: SUPABASE_STORAGE_BUCKET",
    );
  });
});
