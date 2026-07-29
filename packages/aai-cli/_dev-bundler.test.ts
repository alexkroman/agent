// Copyright 2025 the AAI authors. MIT license.
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createDevWorkerBuilder, isBundlerBuildFailure } from "./_dev-bundler.ts";
import { withTempDir, writeFiles } from "./_test-utils.ts";

/** Create a builder, run `fn`, always dispose. */
async function withBuilder(
  dir: string,
  fn: (builder: ReturnType<typeof createDevWorkerBuilder>) => Promise<void>,
): Promise<void> {
  const builder = createDevWorkerBuilder(dir);
  try {
    await fn(builder);
  } finally {
    await builder.dispose();
  }
}

describe("createDevWorkerBuilder", () => {
  test("builds agent.ts into a single ESM string", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "agent.ts"),
        `export default { name: "dev-test", tools: {} };`,
      );
      await withBuilder(dir, async (builder) => {
        const code = await builder.build();
        expect(code).toMatch(/export/);
        expect(code).toContain("dev-test");
      });
    });
  });

  test("bundles local imports and .md files as raw text (rawMdPlugin parity)", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        "agent.ts": `import systemPrompt from "./system-prompt.md";
import { helper } from "./tools.ts";
export default { name: "md-test", systemPrompt, greeting: helper(), tools: {} };`,
        "system-prompt.md": "# You are a test agent",
        "tools.ts": `export const helper = () => "from-local-module";`,
      });
      await withBuilder(dir, async (builder) => {
        const code = await builder.build();
        expect(code).toContain("# You are a test agent");
        expect(code).toContain("from-local-module");
      });
    });
  });

  test("supports Vite-style ?raw suffix imports", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        "agent.ts": `import text from "./notes.txt?raw";
export default { name: "raw-test", systemPrompt: text, tools: {} };`,
        "notes.txt": "raw-suffix-content",
      });
      await withBuilder(dir, async (builder) => {
        const code = await builder.build();
        expect(code).toContain("raw-suffix-content");
      });
    });
  });

  test("keeps node: builtins external, bundles npm deps in (deploy parity)", async () => {
    await withTempDir(async (dir) => {
      // Symlink node_modules so the bundler can resolve zod, like _build.test.ts.
      await symlink(
        path.resolve(import.meta.dirname, "node_modules"),
        path.join(dir, "node_modules"),
      );
      await writeFiles(dir, {
        "agent.ts": `import path from "node:path";
import { z } from "zod";
const schema = z.object({ name: z.string() });
export default { name: path.basename("/x/builtin-test"), schema, tools: {} };`,
      });
      await withBuilder(dir, async (builder) => {
        const code = await builder.build();
        // Builtin stays an import; zod is inlined (no bare "zod" import left).
        expect(code).toMatch(/from\s*"node:path"/);
        expect(code).not.toMatch(/from\s*"zod"/);
      });
    });
  });

  test("rebuild picks up edits to transitively imported files", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        "agent.ts": `import { greeting } from "./tools.ts";
export default { name: "rebuild-test", greeting, tools: {} };`,
        "tools.ts": `export const greeting = "version-one";`,
      });
      await withBuilder(dir, async (builder) => {
        const first = await builder.build();
        expect(first).toContain("version-one");

        await writeFile(path.join(dir, "tools.ts"), `export const greeting = "version-two";`);
        const second = await builder.build();
        expect(second).toContain("version-two");
        expect(second).not.toContain("version-one");
      });
    });
  });

  test("compile errors reject as build failures (restart loop reports them)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "agent.ts"), `export default { name: "broken",`);
      await withBuilder(dir, async (builder) => {
        const err = await builder.build().catch((e: unknown) => e);
        expect(isBundlerBuildFailure(err)).toBe(true);
      });
    });
  });

  test("recovers across rebuilds after a compile error", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "agent.ts"), `export default { name: "broken",`);
      await withBuilder(dir, async (builder) => {
        await expect(builder.build()).rejects.toThrow();
        await writeFile(path.join(dir, "agent.ts"), `export default { name: "fixed", tools: {} };`);
        const code = await builder.build();
        expect(code).toContain("fixed");
      });
    });
  });

  test("dispose is idempotent and safe before any build", async () => {
    await withTempDir(async (dir) => {
      const builder = createDevWorkerBuilder(dir);
      await builder.dispose();
      await builder.dispose();
    });
  });
});

describe("isBundlerBuildFailure", () => {
  test("false for plain errors and non-errors", () => {
    expect(isBundlerBuildFailure(new Error("nope"))).toBe(false);
    expect(isBundlerBuildFailure("string")).toBe(false);
    expect(isBundlerBuildFailure(undefined)).toBe(false);
  });

  test("true for errors carrying a bundler errors array", () => {
    const err = Object.assign(new Error("Build failed"), { errors: [] });
    expect(isBundlerBuildFailure(err)).toBe(true);
  });
});
