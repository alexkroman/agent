// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BundleError, createClientDevServer } from "./_bundler.ts";

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
    const { bundleAgent } = await import("./_bundler.ts");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_bundle_"));
    try {
      await expect(
        bundleAgent({
          slug: "test",
          dir: tmpDir,
          entryPoint: path.join(tmpDir, "agent.ts"),
          clientEntry: "",
        }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe("createClientDevServer", () => {
  test("creates a Vite dev server with proxy config", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_dev_"));
    await fs.writeFile(path.join(tmpDir, "index.html"), "<html><body></body></html>");
    try {
      const vite = await createClientDevServer(tmpDir, 9999, 0);
      try {
        expect(vite).toBeDefined();
        expect(vite.config.root).toBe(tmpDir);
        expect(vite.config.server.proxy).toBeDefined();
        const proxy = vite.config.server.proxy as Record<string, unknown>;
        expect(proxy["/health"]).toBeDefined();
        expect(proxy["/websocket"]).toBeDefined();
      } finally {
        await vite.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
