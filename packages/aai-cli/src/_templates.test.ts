// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { withTempDir, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";

// Mock isDevMode — default to false so it resolves via AAI_TEMPLATES_DIR,
// which we point at our fake templates root.
vi.mock("./_agent.ts", () => ({
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

const {
  bundledTemplatesDir,
  downloadAndMergeTemplate,
  layerScaffold,
  mergeScaffoldManifest,
  templateCopyFilter,
} = await import("./_templates.ts");

/** Create a fake templates root with scaffold + two templates, and point resolution at it. */
async function useFakeRoot(dir: string): Promise<void> {
  const rootDir = await writeFiles(path.join(dir, "templates-root"), {
    "scaffold/tsconfig.json": '{"compilerOptions":{}}',
    "scaffold/package.json": JSON.stringify({ name: "scaffold", dependencies: {} }),
    "scaffold/.env.example": "API_KEY=",
    // The authoring guide, stood in for by its first line. The real one is
    // 120KB and is NOT what a scaffolded project gets — see the
    // "authoring guide" tests below.
    "scaffold/CLAUDE.md": "# Writing an aai agent\n\nThe whole SDK reference.\n",
    "templates/simple/agent.ts": 'export default { name: "simple" };',
    "templates/web-researcher/agent.ts": 'export default { name: "web-researcher" };',
    // Template-specific package.json that should take priority over scaffold
    "templates/web-researcher/package.json": JSON.stringify({
      name: "web-researcher-template",
      dependencies: { "node-fetch": "^3.0.0" },
    }),
  });
  vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
}

describe("bundled templates", () => {
  // `bundle-templates.mjs` copies templates/ and scaffold/ next to the built
  // entry, so the shipped location is the module's own directory. Published
  // that resolves to dist/; running source in the monorepo it resolves to the
  // package root, which has no templates — the monorepo branch covers that.
  test("resolves alongside the module, which is where the build copies them", () => {
    expect(bundledTemplatesDir()).toBe(import.meta.dirname);
  });

  test("is the last resort, after the env override and the monorepo", async () => {
    await withTempDir(async (dir) => {
      // No AAI_TEMPLATES_DIR, getMonorepoRoot() mocked to null: nothing left
      // but the bundled dir, which has no templates/ when running source.
      await expect(downloadAndMergeTemplate("simple", path.join(dir, "out"))).rejects.toThrow(
        "Templates directory is missing or unreadable",
      );
    });
  });
});

/**
 * A template directory is also a runnable project, so a developer who ran
 * `aai dev`/`aai publish` in one leaves untracked build output behind. Both
 * copies out of it — this one and `bundle-templates.mjs`, which packs the
 * published tarball — took all of it: `aai init foo --template bar` produced a
 * project already linked to `bar`'s last local deploy, and its first publish
 * either claimed a slug the user never chose or refused the `localhost` origin
 * a dev checkout leaves in `.aai/project.json`.
 */
describe("templateCopyFilter", () => {
  test.for([".aai", "node_modules", "dist", ".workflow-data", ".swc", ".git"])(
    "%s is never copied out of a template",
    (name) => {
      expect(templateCopyFilter(path.join("/templates/simple", name))).toBe(false);
    },
  );

  test.for([".env", ".env.local", "pnpm-lock.yaml", "package-lock.json", ".DS_Store"])(
    "%s is never copied out of a template",
    (name) => {
      expect(templateCopyFilter(path.join("/templates/simple", name))).toBe(false);
    },
  );

  // The scaffold SHIPS `.env.example` and a scaffolded project cannot do
  // without it, so the filter has to let it through — the whole reason
  // `LOCAL_ONLY_FILES` excludes that one name.
  test.for([".env.example", "agent.ts", "client.tsx", "package.json", ".gitignore"])(
    "%s is copied",
    (name) => {
      expect(templateCopyFilter(path.join("/templates/simple", name))).toBe(true);
    },
  );

  test("does not reject the template directory it is copying", () => {
    expect(templateCopyFilter("/templates/simple")).toBe(true);
    expect(templateCopyFilter("/root/scaffold")).toBe(true);
  });

  // The BUILD-time copy is the one that packs the published tarball
  // (`files: ["bin.mjs", "dist"]`), and it is a plain script no other test
  // reaches — it copies from the working tree into `dist/`, so running it here
  // would rewrite a build artifact. Its wiring is what has to hold: measured on
  // a real build before the filter, `dist/templates` carried 26 stray
  // `.aai/project.json` files and 9.4 MB of one developer's `.aai/client`
  // bundles out of 12 MB.
  test("the build-time copy uses this same filter", async () => {
    const script = await fs.readFile(
      path.join(import.meta.dirname, "../bundle-templates.mjs"),
      "utf-8",
    );
    expect(script).toContain('import { templateCopyFilter } from "./src/_templates.ts"');
    expect(script).toContain("filter: templateCopyFilter");
  });

  test("skips a template's build output and machine state end to end", async () => {
    await withTempDir(async (dir) => {
      const rootDir = await writeFiles(path.join(dir, "templates-root"), {
        "scaffold/.env.example": "API_KEY=",
        "templates/simple/agent.ts": 'export default { name: "simple" };',
        // What `aai publish` and `aai dev` leave in a template directory.
        "templates/simple/.aai/project.json":
          '{"slug":"simple","serverUrl":"http://localhost:8080"}',
        "templates/simple/.aai/client/index.html": "<html></html>",
        "templates/simple/.workflow-data/run.json": "{}",
        "templates/simple/node_modules/zod/package.json": "{}",
        "templates/simple/.env": "ASSEMBLYAI_API_KEY=sk-real-secret",
        "templates/simple/pnpm-lock.yaml": "lockfileVersion: '9.0'",
      });
      vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
      const target = path.join(dir, "output");
      await downloadAndMergeTemplate("simple", target);

      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
      expect(await fileExists(path.join(target, ".env.example"))).toBe(true);
      for (const rel of [
        ".aai/project.json",
        ".aai/client/index.html",
        ".workflow-data/run.json",
        "node_modules/zod/package.json",
        ".env",
        "pnpm-lock.yaml",
      ]) {
        expect.soft(await fileExists(path.join(target, rel)), rel).toBe(false);
      }
    });
  });
});

describe("downloadAndMergeTemplate", () => {
  test("copies template files to target directory", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await downloadAndMergeTemplate("simple", target);
      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
      const content = await fs.readFile(path.join(target, "agent.ts"), "utf-8");
      expect(content).toContain("simple");
    });
  });

  test("copies scaffold files underneath template files", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await downloadAndMergeTemplate("simple", target);
      // Scaffold files that don't conflict with template should be copied
      expect(await fileExists(path.join(target, "tsconfig.json"))).toBe(true);
      expect(await fileExists(path.join(target, ".env.example"))).toBe(true);
      // Scaffold package.json should also be present (simple template has no package.json)
      expect(await fileExists(path.join(target, "package.json"))).toBe(true);
    });
  });

  describe("the authoring guide is pointed at, not copied", () => {
    test("the project's CLAUDE.md names the SDK copy and is not the guide", async () => {
      await withTempDir(async (dir) => {
        await useFakeRoot(dir);
        const target = path.join(dir, "output");
        await downloadAndMergeTemplate("simple", target);
        const guide = await fs.readFile(path.join(target, "CLAUDE.md"), "utf-8");
        // The scaffold's own CLAUDE.md is the 120KB authoring guide. Copying it
        // put a file the SDK's shipped skill calls non-authoritative into every
        // project, and Claude Code loads a project-root CLAUDE.md in full at
        // launch — so what lands is a pointer at the version-matched copy.
        expect(guide).not.toContain("The whole SDK reference.");
        expect(guide).toContain("node_modules/@alexkroman1/aai/AGENT_GUIDE.md");
        // In a FENCE, which is the documented spelling for "mention, do not
        // import": an `@path` outside backticks is expanded into context at
        // launch, which would put the 120KB straight back.
        expect(guide).toContain("```text\nnode_modules/@alexkroman1/aai/AGENT_GUIDE.md\n```");
        // Small enough to be worth loading every session — Claude Code's
        // documented target is 200 lines.
        expect.soft(guide.split("\n").length).toBeLessThan(200);
      });
    });

    test("a project's own CLAUDE.md wins, like every other scaffold file", async () => {
      await withTempDir(async (dir) => {
        await useFakeRoot(dir);
        const target = path.join(dir, "output");
        await writeFiles(target, { "CLAUDE.md": "# my notes\n" });
        await layerScaffold(target);
        expect(await fs.readFile(path.join(target, "CLAUDE.md"), "utf-8")).toBe("# my notes\n");
      });
    });

    test("a TEMPLATE's CLAUDE.md is still copied, and still wins", async () => {
      await withTempDir(async (dir) => {
        await useFakeRoot(dir);
        const target = path.join(dir, "output");
        // Only the SCAFFOLD's CLAUDE.md is the guide. A template's would be
        // that template's own notes, so the filter is keyed on the full path.
        await fs.writeFile(
          path.join(process.env.AAI_TEMPLATES_DIR ?? "", "templates/simple/CLAUDE.md"),
          "# simple's notes\n",
        );
        await downloadAndMergeTemplate("simple", target);
        expect(await fs.readFile(path.join(target, "CLAUDE.md"), "utf-8")).toBe(
          "# simple's notes\n",
        );
      });
    });
  });

  test("template files take priority over scaffold files", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      // web-researcher has its own package.json which should win over scaffold
      await downloadAndMergeTemplate("web-researcher", target);
      const pkgJson = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(pkgJson.name).toBe("web-researcher-template");
      expect(pkgJson.dependencies["node-fetch"]).toBe("^3.0.0");
    });
  });

  test("throws for unknown template", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await expect(downloadAndMergeTemplate("nonexistent", target)).rejects.toThrow(
        'Unknown template "nonexistent"',
      );
    });
  });

  test("error message lists available templates", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "output");
      await expect(downloadAndMergeTemplate("bad-name", target)).rejects.toThrow(
        "Available templates: simple, web-researcher",
      );
    });
  });

  test("creates target directory if it does not exist", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "deeply", "nested", "output");
      // fs.cp with recursive:true creates the target directory
      await downloadAndMergeTemplate("simple", target);
      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
    });
  });

  test("reports a corrupt/incomplete templates root instead of raw ENOENT", async () => {
    await withTempDir(async (dir) => {
      // A root with no templates/ directory — what a broken download leaves.
      const emptyRoot = path.join(dir, "empty-root");
      await fs.mkdir(emptyRoot, { recursive: true });
      vi.stubEnv("AAI_TEMPLATES_DIR", emptyRoot);
      await expect(downloadAndMergeTemplate("simple", path.join(dir, "out"))).rejects.toThrow(
        "Templates directory is missing or unreadable",
      );
    });
  });

  test("handles template with no scaffold directory", async () => {
    await withTempDir(async (dir) => {
      // Create a root with templates but no scaffold
      const root = await writeFiles(path.join(dir, "no-scaffold-root"), {
        "templates/simple/agent.ts": "export default {};",
      });
      vi.stubEnv("AAI_TEMPLATES_DIR", root);

      const target = path.join(dir, "output");
      // Should not throw even without scaffold dir
      await downloadAndMergeTemplate("simple", target);
      expect(await fileExists(path.join(target, "agent.ts"))).toBe(true);
    });
  });
});

describe("mergeScaffoldManifest", () => {
  test("fills top-level fields the manifest lacks, and keeps the ones it has", () => {
    const merged = mergeScaffoldManifest(
      { type: "module", name: "mine" },
      { type: "commonjs", engines: { node: ">=24" }, packageManager: "pnpm@10" },
    );
    expect(merged).toEqual({
      type: "module",
      name: "mine",
      engines: { node: ">=24" },
      packageManager: "pnpm@10",
    });
  });

  test("merges dependency maps per ENTRY, so declared pins survive", () => {
    // A pulled studio workspace pins exact installed versions; the scaffold's
    // caret ranges must not clobber them.
    const merged = mergeScaffoldManifest(
      { dependencies: { "@alexkroman1/aai": "5.7.1" } },
      { dependencies: { "@alexkroman1/aai": "^5.7.0", zod: "^4.4.3" } },
    );
    expect(merged?.dependencies).toEqual({ "@alexkroman1/aai": "5.7.1", zod: "^4.4.3" });
  });

  test("one agent-added devDependency does not shadow the whole toolchain block", () => {
    const merged = mergeScaffoldManifest(
      { devDependencies: { "some-tool": "^1.0.0" } },
      { devDependencies: { vite: "^8.1.5", "@vitejs/plugin-react": "^6.0.4" } },
    );
    expect(merged?.devDependencies).toEqual({
      "some-tool": "^1.0.0",
      vite: "^8.1.5",
      "@vitejs/plugin-react": "^6.0.4",
    });
  });

  test("nothing missing → null, so no file is rewritten", () => {
    expect(mergeScaffoldManifest({ type: "module" }, { type: "commonjs" })).toBeNull();
    expect(
      mergeScaffoldManifest({ dependencies: { zod: "1" } }, { dependencies: { zod: "^4" } }),
    ).toBeNull();
  });
});

describe("layerScaffold", () => {
  test("completes a pulled workspace manifest with the scaffold's toolchain", async () => {
    // The regression: a studio workspace declares its runtime deps and no
    // toolchain (baked into the guest sandbox), so a plain skip-if-exists
    // layering left `vite` uninstallable and `aai dev` unable to resolve the
    // vite.config.ts the same layering had just written.
    await withTempDir(async (dir) => {
      const rootDir = await writeFiles(path.join(dir, "templates-root"), {
        "scaffold/vite.config.ts": 'import { defineConfig } from "vite";',
        "scaffold/package.json": JSON.stringify({
          type: "module",
          scripts: { dev: "aai dev" },
          dependencies: { "@alexkroman1/aai": "^5.7.0", zod: "^4.4.3" },
          devDependencies: { vite: "^8.1.5", "@vitejs/plugin-react": "^6.0.4" },
        }),
      });
      vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);

      const target = await writeFiles(path.join(dir, "pulled"), {
        "agent.ts": "export default {};",
        "package.json": JSON.stringify({
          name: "aai-studio-workspace",
          private: true,
          type: "module",
          dependencies: { "@alexkroman1/aai": "5.7.1" },
        }),
      });
      await layerScaffold(target);

      const pkg = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(pkg.name).toBe("aai-studio-workspace");
      expect(pkg.dependencies["@alexkroman1/aai"]).toBe("5.7.1");
      expect(pkg.devDependencies.vite).toBe("^8.1.5");
      expect(pkg.devDependencies["@vitejs/plugin-react"]).toBe("^6.0.4");
      expect(pkg.scripts.dev).toBe("aai dev");
      // The config that needs those deps is layered in by the same call.
      expect(await fileExists(path.join(target, "vite.config.ts"))).toBe(true);
    });
  });

  test("a directory with no manifest just gets the scaffold's, verbatim", async () => {
    await withTempDir(async (dir) => {
      await useFakeRoot(dir);
      const target = path.join(dir, "empty");
      await fs.mkdir(target, { recursive: true });
      await layerScaffold(target);
      const pkg = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(pkg.name).toBe("scaffold");
    });
  });
});
