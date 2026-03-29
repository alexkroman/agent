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

describe("bundleAgent: readDirFiles coverage", () => {
  test("handles missing client directory gracefully", async () => {
    const { bundleAgent } = await import("./_bundler.ts");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_bundle_"));
    try {
      // Create a minimal agent.ts that Vite can build
      await fs.writeFile(
        path.join(tmpDir, "agent.ts"),
        'export default { name: "test", instructions: "test", greeting: "hi", maxSteps: 1, tools: {} };',
      );
      // Package.json needed for Vite resolution
      await fs.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );

      const result = await bundleAgent({
        slug: "test",
        dir: tmpDir,
        entryPoint: path.join(tmpDir, "agent.ts"),
        clientEntry: "", // no client → skipClient
      });

      expect(result.worker).toBeDefined();
      expect(result.workerBytes).toBeGreaterThan(0);
      // No client files since clientEntry is empty
      expect(Object.keys(result.clientFiles).length).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  test("reads binary files as base64-encoded strings", async () => {
    const { bundleAgent } = await import("./_bundler.ts");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_bundle_"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "agent.ts"),
        'export default { name: "test", instructions: "test", greeting: "hi", maxSteps: 1, tools: {} };',
      );
      await fs.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );

      // Create a fake client dir with a binary file
      const clientDir = path.join(tmpDir, ".aai", "client");
      await fs.mkdir(clientDir, { recursive: true });
      await fs.writeFile(path.join(clientDir, "index.html"), "<html></html>");
      // Write a binary .png file
      await fs.writeFile(
        path.join(clientDir, "favicon.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      const result = await bundleAgent({
        slug: "test",
        dir: tmpDir,
        entryPoint: path.join(tmpDir, "agent.ts"),
        clientEntry: "", // skipClient so vite doesn't run client build
      });

      // The pre-existing client dir files should be read
      // (bundleAgent reads clientDir after build; since skipClient, the dir already has our files)
      expect(result.clientFiles["index.html"]).toBe("<html></html>");
      expect(result.clientFiles["favicon.png"]).toMatch(/^base64:/);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe("createClientDevServer", () => {
  test("creates a Vite dev server", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_dev_"));
    await fs.writeFile(path.join(tmpDir, "index.html"), "<html><body></body></html>");
    try {
      const vite = await createClientDevServer(tmpDir, 0);
      try {
        expect(vite).toBeDefined();
        expect(vite.config.root).toBe(tmpDir);
      } finally {
        await vite.close();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
