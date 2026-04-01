// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BundleError } from "./bundler.ts";

describe("BundleError", () => {
  test("creates error with BundleError name", () => {
    const err = new BundleError("something went wrong");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BundleError);
    expect(err.name).toBe("BundleError");
    expect(err.message).toBe("something went wrong");
  });

  test("instanceof check works in catch blocks", () => {
    try {
      throw new BundleError("build failed");
    } catch (err) {
      expect(err instanceof BundleError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });

  test("preserves stack trace", () => {
    const err = new BundleError("trace test");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("trace test");
  });
});

describe("bundleAgent", () => {
  test("throws BundleError when agent dir has no valid entry", async () => {
    const { bundleAgent } = await import("./bundler.ts");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_bundle_"));
    try {
      await expect(
        bundleAgent({
          slug: "test",
          dir: tmpDir,
          tomlPath: path.join(tmpDir, "agent.toml"),
          toolsEntry: path.join(tmpDir, "tools.ts"),
          clientEntry: "",
        }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
