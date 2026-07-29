// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { patchPackageJsonForWorkspace, runInit } from "./_init.ts";
import { silenced, withTempDir, writeFiles } from "./_test-utils.ts";
import { fileExists } from "./_utils.ts";
import { executeInit, resolvePnpmCommand } from "./init.ts";

/**
 * Create a fake templates root (real scaffold files + test extras) and point
 * template resolution at it via AAI_TEMPLATES_DIR.
 */
async function useFakeTemplates(dir: string): Promise<void> {
  const rootDir = path.join(dir, "fake-root");
  // Copy real scaffold files so tests validate actual scaffold content
  const realScaffold = path.resolve(import.meta.dirname, "../aai-templates/scaffold");
  await fs.cp(realScaffold, path.join(rootDir, "scaffold"), { recursive: true });
  await writeFiles(rootDir, {
    "scaffold/shared.txt": "from shared",
    "scaffold/.env.example": "MY_KEY=",
    "templates/simple/agent.json": JSON.stringify({ name: "Default Name" }),
    "templates/simple/readme.txt": "hello",
    // Empty package.json (no deps) so executeInit skips pnpm install — hermetic.
    "templates/simple/package.json": "{}",
  });
  vi.stubEnv("AAI_TEMPLATES_DIR", rootDir);
}

const executeDeploy = vi.hoisted(() => vi.fn());
vi.mock("./deploy.ts", () => ({ executeDeploy }));

// executeInit shells out (corepack/safe-chain/pnpm) only when the scaffolded
// project has dependencies; mock execa so those paths are testable hermetically.
const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

/** Add a template whose package.json declares deps, so installDeps runs. */
async function addDepsTemplate(dir: string): Promise<void> {
  await writeFiles(path.join(dir, "fake-root"), {
    "templates/deps/agent.json": JSON.stringify({ name: "Deps" }),
    "templates/deps/package.json": JSON.stringify({ dependencies: { zod: "^4.0.0" } }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runInit", () => {
  test("copies template and shared files to target", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fs.readFile(path.join(target, "agent.json"), "utf-8")).toContain(
          "Default Name",
        );
        expect(await fs.readFile(path.join(target, "readme.txt"), "utf-8")).toBe("hello");
        expect(await fs.readFile(path.join(target, "shared.txt"), "utf-8")).toBe("from shared");
      }),
    );
  });

  test("skips node_modules", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, "node_modules"))).toBe(false);
        expect(await fileExists(path.join(target, "package.json"))).toBe(true);
      }),
    );
  });

  test("copies .env.example to .env from shared", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        expect(await fileExists(path.join(target, ".env"))).toBe(true);
        expect(await fs.readFile(path.join(target, ".env"), "utf-8")).toBe("MY_KEY=");
      }),
    );
  });
});

describe("resolvePnpmCommand", () => {
  test("uses safe-chain when available", async () => {
    const result = await resolvePnpmCommand(() => Promise.resolve(true));
    expect(result.cmd).toBe("safe-chain");
    expect(result.args).toContain("pnpm");
    expect(result.args).toContain("--safe-chain-skip-minimum-package-age");
  });

  test("falls back to pnpm when safe-chain is not available", async () => {
    const result = await resolvePnpmCommand(() => Promise.resolve(false));
    expect(result.cmd).toBe("pnpm");
    expect(result.args).not.toContain("--safe-chain-skip-minimum-package-age");
  });
});

describe("scaffold client.tsx", () => {
  test("scaffold does not include client.tsx (default UI served by dev server)", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "output");
        await runInit({ targetDir: target, template: "simple" });
        const clientPath = path.join(target, "client.tsx");
        expect(await fileExists(clientPath)).toBe(false);
      }),
    );
  });
});

describe("executeInit", () => {
  beforeEach(() => {
    executeDeploy.mockReset();
    execaMock.mockReset();
  });

  test("installs deps then deploys when the template declares dependencies", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "with-deps");
        // corepack enable ok, safe-chain missing, pnpm install ok
        execaMock.mockImplementation((cmd: string) =>
          Promise.resolve({ failed: cmd === "safe-chain" }),
        );
        executeDeploy.mockResolvedValue({
          ok: true,
          data: { slug: "with-deps", url: "https://agents.test/with-deps" },
        });

        const result = await executeInit(
          { dir: target, template: "deps", server: "https://api.test" },
          { silent: true },
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data.deployed).toBe(true);
        const pnpmCall = execaMock.mock.calls.find(([cmd]) => cmd === "pnpm");
        expect(pnpmCall?.[1]).toContain("install");
        expect(pnpmCall?.[2]).toEqual({ cwd: target });
      }),
    );
  });

  test("routes the install through safe-chain when it is on PATH", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "safe-chained");
        execaMock.mockResolvedValue({ failed: false });

        await executeInit({ dir: target, template: "deps", skipDeploy: true }, { silent: true });

        // Skip the `safe-chain --version` probe; find the actual install.
        const installCall = execaMock.mock.calls.find(
          ([cmd, args]) => cmd === "safe-chain" && (args as string[]).includes("install"),
        );
        expect(installCall?.[1]).toEqual(
          expect.arrayContaining(["pnpm", "--safe-chain-skip-minimum-package-age", "install"]),
        );
      }),
    );
  });

  test("skips deploy when pnpm install fails", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "broken-install");
        execaMock.mockImplementation((cmd: string) =>
          cmd === "pnpm"
            ? Promise.reject(new Error("registry unreachable"))
            : Promise.resolve({ failed: true }),
        );

        const result = await executeInit(
          { dir: target, template: "deps", server: "https://api.test" },
          { silent: true },
        );

        // Deploying without node_modules would fail confusingly further in —
        // the deploy must not even be attempted.
        expect(executeDeploy).not.toHaveBeenCalled();
        expect(result).toEqual({
          ok: true,
          data: { dir: target, template: "deps", deployed: false },
        });
      }),
    );
  });

  test("skips the install entirely when node_modules already exists", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        await addDepsTemplate(dir);
        const target = path.join(dir, "preinstalled");
        await fs.mkdir(path.join(target, "node_modules"), { recursive: true });

        await executeInit({ dir: target, template: "deps", skipDeploy: true }, { silent: true });

        expect(execaMock).not.toHaveBeenCalled();
      }),
    );
  });

  test("scaffolds a project and skips deploy when requested", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "my-agent");

        const result = await executeInit({ dir: target, skipDeploy: true }, { silent: true });

        expect(result).toEqual({
          ok: true,
          data: { dir: target, template: "simple", deployed: false },
        });
        expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
        expect(await fileExists(path.join(target, "shared.txt"))).toBe(true);
        expect(executeDeploy).not.toHaveBeenCalled();
      }),
    );
  });

  test("refuses to overwrite an existing agent.ts without --force", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "existing");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "agent.ts"), "// existing agent");

        await expect(
          executeInit({ dir: target, skipDeploy: true }, { silent: true }),
        ).rejects.toThrow("agent.ts already exists");
      }),
    );
  });

  test("--force overwrites an existing project", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "existing");
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "agent.ts"), "// existing agent");

        const result = await executeInit(
          { dir: target, force: true, skipDeploy: true },
          { silent: true },
        );
        expect(result.ok).toBe(true);
        expect(await fileExists(path.join(target, "agent.json"))).toBe(true);
      }),
    );
  });

  test("deploys after scaffolding and returns slug + url", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "deployed-agent");
        executeDeploy.mockResolvedValue({
          ok: true,
          data: { slug: "deployed-agent", url: "https://agents.test/deployed-agent" },
        });

        const result = await executeInit(
          { dir: target, server: "https://api.test" },
          { silent: true },
        );

        expect(executeDeploy).toHaveBeenCalledWith({ cwd: target, server: "https://api.test" });
        expect(result).toEqual({
          ok: true,
          data: {
            dir: target,
            template: "simple",
            deployed: true,
            slug: "deployed-agent",
            url: "https://agents.test/deployed-agent",
          },
        });
      }),
    );
  });

  test("reports deployed: false when deploy fails", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await useFakeTemplates(dir);
        const target = path.join(dir, "failed-deploy");
        executeDeploy.mockResolvedValue({ ok: false, code: "deploy_failed", error: "boom" });

        const result = await executeInit(
          { dir: target, server: "https://api.test" },
          { silent: true },
        );

        expect(result).toEqual({
          ok: true,
          data: { dir: target, template: "simple", deployed: false },
        });
      }),
    );
  });
});

describe("patchPackageJsonForWorkspace", () => {
  test("rewrites workspace deps to link: paths", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "my-agent");
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(
        path.join(target, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.29.3",
          dependencies: {
            "@alexkroman1/aai": "^0.12.3",
            "@alexkroman1/aai-ui": "^0.12.3",
            preact: "^10.29.0",
          },
          devDependencies: {
            "@alexkroman1/aai-cli": "^0.12.3",
            vitest: "^4.1.1",
          },
        }),
      );

      await patchPackageJsonForWorkspace(target);

      const result = JSON.parse(await fs.readFile(path.join(target, "package.json"), "utf-8"));
      expect(result.name).toBe("my-agent");
      expect(result.packageManager).toBeUndefined();
      expect(result.dependencies["@alexkroman1/aai"]).toMatch(/^link:/);
      expect(result.dependencies["@alexkroman1/aai"]).toContain("/aai");
      expect(result.dependencies["@alexkroman1/aai-ui"]).toMatch(/^link:/);
      expect(result.dependencies.preact).toBe("^10.29.0");
      expect(result.devDependencies["@alexkroman1/aai-cli"]).toMatch(/^link:/);
      expect(result.devDependencies.vitest).toBe("^4.1.1");
    });
  });
});
