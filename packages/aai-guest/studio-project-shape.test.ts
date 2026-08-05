// Copyright 2026 the AAI authors. MIT license.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ensureProjectShape,
  resolveWorkspaceDependencies,
  WORKSPACE_GLOBAL_DTS,
  WORKSPACE_TSCONFIG,
  WORKSPACE_VITE_CONFIG,
  WORKSPACE_VITEST_CONFIG,
} from "./studio-project-shape.ts";

let dir: string;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("ensureProjectShape", () => {
  test("writes the missing project files", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
    await ensureProjectShape(dir);
    for (const rel of [
      "package.json",
      "tsconfig.json",
      "global.d.ts",
      "vite.config.ts",
      "vitest.config.ts",
    ]) {
      await expect(readFile(path.join(dir, rel), "utf-8")).resolves.toBeTruthy();
    }
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as {
      type?: string;
      dependencies?: Record<string, string>;
    };
    expect(pkg.type).toBe("module");
    // The manifest is what the coding agent reads to learn what it may
    // import, so it has to name the SDK rather than leave it implicit.
    expect(Object.keys(pkg.dependencies ?? {})).toContain("@alexkroman1/aai");
  });

  test("pins dependencies to exact installed versions, never ranges", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
    await ensureProjectShape(dir);
    const { dependencies = {} } = JSON.parse(
      await readFile(path.join(dir, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(dependencies).length).toBeGreaterThan(0);
    // `add_dependency` reifies the whole manifest; a range there could
    // materialize a different SDK build than the harness resolved, into a
    // workspace node_modules that shadows the baked one.
    for (const [name, version] of Object.entries(dependencies)) {
      expect({ name, version }).toEqual({ name, version: expect.stringMatching(/^\d+\.\d+\./) });
    }
  });

  test("never overwrites files the workspace already has", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
    await writeFile(path.join(dir, "tsconfig.json"), "{}", "utf-8");
    await ensureProjectShape(dir);
    // The coding agent's own tsconfig wins, exactly as a CLI user's would.
    await expect(readFile(path.join(dir, "tsconfig.json"), "utf-8")).resolves.toBe("{}");
  });

  /**
   * The pins are exact versions of the installed toolchain. Ship a new SDK and
   * an old manifest goes stale — and `add_dependency` reifies the WHOLE
   * manifest, so the stale pin materializes an OLD SDK into a workspace-local
   * node_modules that SHADOWS the baked one.
   */
  describe("existing package.json pins", () => {
    const readPkg = async (): Promise<Record<string, string>> => {
      const { dependencies = {} } = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf-8"),
      ) as { dependencies?: Record<string, string> };
      return dependencies;
    };

    test("are reconciled against the installed toolchain", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
      const installed = resolveWorkspaceDependencies();
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "w", dependencies: { "@alexkroman1/aai": "0.0.1" } }),
        "utf-8",
      );
      await ensureProjectShape(dir);
      expect((await readPkg())["@alexkroman1/aai"]).toBe(installed["@alexkroman1/aai"]);
    });

    test("leave the agent's own dependencies alone", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "w",
          type: "module",
          dependencies: { "@alexkroman1/aai": "0.0.1", "date-fns": "^4.1.0" },
          scripts: { test: "vitest run" },
        }),
        "utf-8",
      );
      await ensureProjectShape(dir);
      const deps = await readPkg();
      expect(deps["date-fns"]).toBe("^4.1.0");
      const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as {
        scripts?: Record<string, string>;
        type?: string;
      };
      // Everything but the pins survives — this is a reconcile, not a rewrite.
      expect(pkg.scripts?.test).toBe("vitest run");
      expect(pkg.type).toBe("module");
    });

    // `npm install` reifies only what is declared, so an absent entry is no
    // shadowing hazard — and re-adding one would override a deliberate removal.
    test("are not added back when the manifest omits them", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "w", dependencies: { "date-fns": "^4.1.0" } }),
        "utf-8",
      );
      await ensureProjectShape(dir);
      expect(await readPkg()).toEqual({ "date-fns": "^4.1.0" });
    });

    // The agent may be mid-edit, and `npm install` reports a broken manifest
    // far better than a silent rewrite would.
    test("leave an unparseable manifest untouched", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
      await writeFile(path.join(dir, "package.json"), "{ not json", "utf-8");
      await ensureProjectShape(dir);
      await expect(readFile(path.join(dir, "package.json"), "utf-8")).resolves.toBe("{ not json");
    });

    test("rewrite nothing when the pins already match", async () => {
      dir = await mkdtemp(path.join(tmpdir(), "aai-shape-"));
      await ensureProjectShape(dir);
      const before = await readFile(path.join(dir, "package.json"), "utf-8");
      await ensureProjectShape(dir);
      expect(await readFile(path.join(dir, "package.json"), "utf-8")).toBe(before);
    });
  });

  test("tsconfig excludes tests and pins node types (studio variant)", () => {
    const parsed = JSON.parse(WORKSPACE_TSCONFIG) as {
      compilerOptions: Record<string, unknown> & { types: string[] };
      exclude: string[];
    };
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.types).toEqual(["node"]);
    expect(parsed.exclude).toContain("**/*.test.ts");
    // Deliberate: implicit-any diagnostics are churn on an `any` receiver and
    // catch nothing. See the WORKSPACE_TSCONFIG doc.
    expect(parsed.compilerOptions.noImplicitAny).toBe(false);
    expect(parsed.compilerOptions.useUnknownInCatchVariables).toBe(false);
  });
});

describe("scaffold parity (drift guard)", () => {
  const scaffold = (file: string) =>
    readFile(path.resolve(import.meta.dirname, "../aai-templates/scaffold", file), "utf-8");

  test("vite.config.ts matches the scaffold's byte for byte", async () => {
    await expect(scaffold("vite.config.ts")).resolves.toBe(WORKSPACE_VITE_CONFIG);
  });

  test("global.d.ts matches the scaffold's byte for byte", async () => {
    await expect(scaffold("global.d.ts")).resolves.toBe(WORKSPACE_GLOBAL_DTS);
  });

  /**
   * Compared on the config body, not byte for byte: the scaffold's copy
   * carries a long doc comment explaining why the test config is separate
   * from the vite one, which a generated workspace does not need.
   */
  test("vitest config enables globals, in both copies", async () => {
    const body = (text: string) => text.slice(text.indexOf("export default"));
    expect(body(WORKSPACE_VITEST_CONFIG)).toBe(body(await scaffold("vitest.config.ts")));
    expect(WORKSPACE_VITEST_CONFIG).toContain("globals: true");
    // It must not import the client build's plugins — that is the whole
    // reason it exists apart from vite.config.ts.
    expect(WORKSPACE_VITEST_CONFIG).not.toContain("plugin-react");
    expect(WORKSPACE_VITEST_CONFIG).not.toContain("tailwindcss");
  });

  /**
   * The tsconfigs differ deliberately (`types`, `exclude`), so they cannot be
   * compared byte for byte — but the settings that decide whether a given file
   * type-checks must agree, or a workspace that builds in the studio fails
   * `aai build` on the user's laptop after they export it.
   */
  test("declares exactly the scaffold's runtime dependencies", async () => {
    const { dependencies = {} } = JSON.parse(await scaffold("package.json")) as {
      dependencies?: Record<string, string>;
    };
    // Names only — the scaffold uses carets for a user's own install, while
    // the workspace pins to what the sandbox has. The SET is the contract:
    // a package added to the scaffold that the studio never declares is one
    // the coding agent will not know it can import.
    expect(Object.keys(resolveWorkspaceDependencies()).sort()).toEqual(
      Object.keys(dependencies).sort(),
    );
  });

  test("tsconfig strictness matches the scaffold's", async () => {
    type Opts = Record<string, unknown>;
    const of = (text: string) => (JSON.parse(text) as { compilerOptions: Opts }).compilerOptions;
    const mine = of(WORKSPACE_TSCONFIG);
    const theirs = of(await scaffold("tsconfig.json"));
    const shared = [
      "strict",
      "noImplicitAny",
      "useUnknownInCatchVariables",
      "verbatimModuleSyntax",
      "target",
      "lib",
      "jsx",
    ];
    for (const key of shared) {
      expect({ [key]: mine[key] }).toEqual({ [key]: theirs[key] });
    }
  });
});
