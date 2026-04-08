// Copyright 2025 the AAI authors. MIT license.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BundleError, extractAgentConfig, transformBundleForEval } from "./_bundler.ts";

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

describe("bundleAgent: zod externalization", () => {
  test("worker bundle must not contain zod — it crashes secure-exec isolates", async () => {
    const { bundleAgent } = await import("./_bundler.ts");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aai_bundle_"));
    try {
      await fs.writeFile(
        path.join(tmpDir, "agent.ts"),
        `import { z } from "zod";
         export default { name: "test", systemPrompt: "t", greeting: "hi", maxSteps: 1,
           tools: { echo: { description: "echo", parameters: z.object({ text: z.string() }),
             execute: (args) => args.text } } };`,
      );
      await fs.writeFile(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", type: "module", dependencies: { zod: "^4.0.0" } }),
      );

      const result = await bundleAgent({
        slug: "test",
        dir: tmpDir,
        entryPoint: path.join(tmpDir, "agent.ts"),
        clientEntry: "",
      });

      // Zod must be external — the worker should import from /app/_zod.mjs
      expect(result.worker).toContain("/app/_zod.mjs");
      // Must NOT contain zod internals (ZodString, ZodObject, etc.)
      expect(result.worker).not.toMatch(/\bZodString\b/);
      expect(result.worker).not.toMatch(/\bZodObject\b/);
      expect(result.worker).not.toMatch(/\$ZodCheck\b/);
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

describe("transformBundleForEval", () => {
  test("replaces named zod import from /app/_zod.mjs", () => {
    const code = `import { z } from "/app/_zod.mjs";\nexport default { name: "test" };`;
    const result = transformBundleForEval(code);
    expect(result).toContain('var z = __zod__["z"];');
    expect(result).toContain('__exports__.default = { name: "test" }');
    expect(result).not.toMatch(/\bimport\s/);
    expect(result).not.toMatch(/\bexport\s/);
  });

  test("replaces namespace zod import", () => {
    const code = `import * as z from "/app/_zod.mjs";\nexport default {};`;
    const result = transformBundleForEval(code);
    expect(result).toContain("var z = __zod__;");
  });

  test("replaces default zod import", () => {
    const code = `import z from "/app/_zod.mjs";\nexport default {};`;
    const result = transformBundleForEval(code);
    expect(result).toContain("var z = __zod__;");
  });

  test("replaces export { X as default }", () => {
    const code = `var agent = { name: "x" };\nexport { agent as default };`;
    const result = transformBundleForEval(code);
    expect(result).toContain("__exports__.default = agent;");
  });

  test("handles multiple named imports", () => {
    const code = `import { z, ZodError } from "/app/_zod.mjs";\nexport default {};`;
    const result = transformBundleForEval(code);
    expect(result).toContain('var z = __zod__["z"];');
    expect(result).toContain('var ZodError = __zod__["ZodError"];');
  });

  test("handles aliased import", () => {
    const code = `import { z as zod } from "/app/_zod.mjs";\nexport default {};`;
    const result = transformBundleForEval(code);
    expect(result).toContain('var zod = __zod__["z"];');
  });

  test("strips non-zod named imports", () => {
    const code = `import { createHooks } from "hookable";\nimport { foo } from "bar";\nexport default { name: "test" };`;
    const result = transformBundleForEval(code);
    expect(result).not.toContain("hookable");
    expect(result).not.toContain('"bar"');
    expect(result).toContain('__exports__.default = { name: "test" }');
  });

  test("strips bare side-effect imports", () => {
    const code = `import "node:process";\nexport default { name: "test" };`;
    const result = transformBundleForEval(code);
    expect(result).not.toContain("node:process");
    expect(result).toContain('__exports__.default = { name: "test" }');
  });
});

describe("extractAgentConfig", () => {
  test("extracts config from simple CJS agent", () => {
    const code = `export default { name: "test-agent", systemPrompt: "Be helpful", greeting: "Hi", maxSteps: 3, tools: {}, builtinTools: ["web_search"] };`;
    const config = extractAgentConfig(code);
    expect(config.name).toBe("test-agent");
    expect(config.systemPrompt).toBe("Be helpful");
    expect(config.greeting).toBe("Hi");
    expect(config.maxSteps).toBe(3);
    expect(config.builtinTools).toEqual(["web_search"]);
    expect(config.toolSchemas).toEqual([]);
    expect(config.hasState).toBe(false);
    expect(config.hooks.onConnect).toBe(false);
  });

  test("detects hooks and state", () => {
    const code = `export default { name: "test", systemPrompt: "s", tools: {}, state: () => ({ count: 0 }), onConnect: () => {}, onDisconnect: () => {}, maxSteps: () => 5 };`;
    const config = extractAgentConfig(code);
    expect(config.hasState).toBe(true);
    expect(config.hooks.onConnect).toBe(true);
    expect(config.hooks.onDisconnect).toBe(true);
    expect(config.hooks.maxStepsIsFn).toBe(true);
    // maxSteps is a function, so the number should not be included
    expect(config.maxSteps).toBeUndefined();
  });

  test("handles bundles with non-zod ESM imports", () => {
    const code = `import { createHooks } from "hookable";\nexport default { name: "ext-agent", systemPrompt: "test", tools: {} };`;
    const config = extractAgentConfig(code);
    expect(config.name).toBe("ext-agent");
  });

  test("throws for invalid bundle", () => {
    expect(() => extractAgentConfig("this is not valid javascript {{{")).toThrow();
  });

  test("throws when no default export", () => {
    expect(() => extractAgentConfig("var x = 1;")).toThrow(BundleError);
  });

  test("throws when export is missing name", () => {
    expect(() => extractAgentConfig("export default { systemPrompt: 's' };")).toThrow(BundleError);
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
        'export default { name: "test", systemPrompt: "test", greeting: "hi", maxSteps: 1, tools: {} };',
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
        'export default { name: "test", systemPrompt: "test", greeting: "hi", maxSteps: 1, tools: {} };',
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
