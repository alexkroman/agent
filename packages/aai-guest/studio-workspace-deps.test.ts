// Copyright 2026 the AAI authors. MIT license.
// The gate that decides what to install (pure, over a fake resolver) and the
// install itself with the spawn mocked out — the same split
// studio-project-tools.test.ts / studio-project-tools-mocked.test.ts uses.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runCapped } from "./studio-spawn.ts";
import {
  ensureWorkspaceDependencies,
  planWorkspaceDependencies,
  withDependencyWarning,
} from "./studio-workspace-deps.ts";

vi.mock("./studio-spawn.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./studio-spawn.ts")>();
  return { ...mod, runCapped: vi.fn() };
});

const runCappedMock = vi.mocked(runCapped);

const npmResult = (over: Partial<Awaited<ReturnType<typeof runCapped>>> = {}) => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  ...over,
});

let dir: string;
let sharedRoot: string;
let toolchain: string;

beforeEach(async () => {
  // `restoreMocks` covers `vi.spyOn`, not a `vi.fn()` installed by a module
  // mock factory — without this, a previous test's implementation and call
  // count leak into the ones asserting npm was never spawned.
  runCappedMock.mockReset();
  sharedRoot = await mkdtemp(path.join(tmpdir(), "aai-workspaces-"));
  dir = path.join(sharedRoot, "session-1");
  await mkdir(dir, { recursive: true });
  toolchain = await mkdtemp(path.join(tmpdir(), "aai-toolchain-"));
});

afterEach(async () => {
  await rm(sharedRoot, { recursive: true, force: true });
  await rm(toolchain, { recursive: true, force: true });
});

const opts = () => ({ sharedRoot, toolchainModules: toolchain });

/** Write the workspace manifest. */
const manifest = (contents: unknown): Promise<void> =>
  writeFile(path.join(dir, "package.json"), JSON.stringify(contents), "utf-8");

/** Put `name` in the workspace's own node_modules, as `add_dependency` would. */
const installedLocally = (name: string): Promise<string | undefined> =>
  mkdir(path.join(dir, "node_modules", name), { recursive: true });

/** Put `name` in the shared root, where this module installs. */
const installedShared = (name: string): Promise<string | undefined> =>
  mkdir(path.join(sharedRoot, "node_modules", name), { recursive: true });

/** Put `name` in the baked toolchain, where a bare import resolves by walk-up. */
const installedInToolchain = (name: string): Promise<string | undefined> =>
  mkdir(path.join(toolchain, name), { recursive: true });

/** The dependencies of the manifest this module stages for npm. */
async function sharedDependencies(): Promise<Record<string, string>> {
  const raw = await readFile(path.join(sharedRoot, "package.json"), "utf-8");
  return (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
}

describe("planWorkspaceDependencies", () => {
  test("plans the declared packages nothing can resolve, with their specs", () => {
    const plan = planWorkspaceDependencies(
      { dependencies: { ms: "^2.1.3", react: "19.2.8" } },
      (n) => n === "react",
    );
    expect(plan).toEqual({ install: { ms: "^2.1.3" }, skipped: [] });
  });

  test("ignores devDependencies — the toolchain supplies those", () => {
    // A project pushed from a laptop carries the scaffold's whole toolchain
    // block (vite, typescript, vitest). Installing it per publish would be a
    // large download arriving back where we started.
    const plan = planWorkspaceDependencies({ devDependencies: { vite: "^8.0.0" } }, () => false);
    expect(plan.install).toEqual({});
  });

  test("a manifest with no usable dependencies field plans nothing", () => {
    for (const value of [null, {}, { dependencies: null }, { dependencies: "nope" }, "not-json"]) {
      expect.soft(planWorkspaceDependencies(value, () => false).install).toEqual({});
    }
  });

  test("refuses a spec that names a LOCATION rather than a version", () => {
    // These resolve relative to whatever directory npm reads them from, and
    // this module reads them from the shared root rather than the workspace
    // that wrote them — so copying one across would quietly mean something else.
    const plan = planWorkspaceDependencies(
      {
        dependencies: {
          a: "file:../secrets",
          b: "git+ssh://git@host/x.git",
          c: "github:owner/repo",
          d: "npm:alias@1",
          ms: "^2.1.3",
        },
      },
      () => false,
    );
    expect(plan.install).toEqual({ ms: "^2.1.3" });
    expect(plan.skipped).toHaveLength(4);
  });

  test("refuses a name that is not an npm package name", () => {
    const plan = planWorkspaceDependencies({ dependencies: { "--registry": "1" } }, () => false);
    expect(plan.install).toEqual({});
    expect(plan.skipped[0]).toContain("not a valid npm package name");
  });
});

describe("ensureWorkspaceDependencies", () => {
  test("does not spawn npm when every declared package already resolves", async () => {
    await manifest({ dependencies: { ms: "^2.1.3", react: "19.2.8", zod: "4.4.3" } });
    await installedLocally("ms");
    await installedShared("zod");
    await installedInToolchain("react");

    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toBeNull();
    expect(runCappedMock).not.toHaveBeenCalled();
  });

  test("does not spawn npm when there is no manifest to reify", async () => {
    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toBeNull();
    expect(runCappedMock).not.toHaveBeenCalled();
  });

  test("stages only the missing packages, and installs in the shared root", async () => {
    // Not in the workspace: npm reifies whatever manifest it reads as a WHOLE,
    // so installing there would re-fetch the toolchain (measured 25s / 156 MB
    // against 358ms / 28 KB) and let one bad entry block every other package.
    await manifest({ dependencies: { ms: "^2.1.3", react: "19.2.8" } });
    await installedInToolchain("react");
    runCappedMock.mockImplementation(async () => {
      await installedShared("ms");
      return npmResult({ stdout: "added 1 package\n" });
    });

    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toBeNull();
    expect(runCappedMock).toHaveBeenCalledWith(
      "npm",
      ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund", "--loglevel=error"],
      expect.objectContaining({ cwd: sharedRoot, combineStreams: true }),
    );
    await expect(sharedDependencies()).resolves.toEqual({ ms: "^2.1.3" });
    // The workspace's own manifest is the user's file and is never rewritten.
    const workspacePkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8"));
    expect(workspacePkg.dependencies).toEqual({ ms: "^2.1.3", react: "19.2.8" });
  });

  test("the staged manifest MERGES — npm prunes what it no longer declares", async () => {
    await writeFile(
      path.join(sharedRoot, "package.json"),
      JSON.stringify({ dependencies: { "date-fns": "^4.0.0" } }),
      "utf-8",
    );
    await manifest({ dependencies: { ms: "^2.1.3" } });
    runCappedMock.mockImplementation(async () => {
      await installedShared("ms");
      return npmResult();
    });

    await ensureWorkspaceDependencies(dir, opts());

    // Replacing rather than merging would uninstall a package an earlier
    // build in this same sandbox had installed and is still importing.
    await expect(sharedDependencies()).resolves.toEqual({
      "date-fns": "^4.0.0",
      ms: "^2.1.3",
    });
  });

  test("the toolchain's own copy is enough — a local install is never forced", async () => {
    // The platform owns these versions; a second copy below the workspace
    // would shadow the baked one the harness resolved.
    await manifest({ dependencies: { "@alexkroman1/aai": "5.14.0" } });
    await installedInToolchain("@alexkroman1/aai");

    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toBeNull();
    expect(runCappedMock).not.toHaveBeenCalled();
  });

  test("an unresolvable toolchain dir leaves every declared package missing", async () => {
    await manifest({ dependencies: { ms: "^2.1.3" } });
    runCappedMock.mockResolvedValue(npmResult());

    await expect(
      ensureWorkspaceDependencies(dir, { sharedRoot, toolchainModules: null }),
    ).resolves.toContain("ms");
    expect(runCappedMock).toHaveBeenCalledOnce();
  });

  test("reports what is still missing, with npm's output, when the install fails", async () => {
    await manifest({ dependencies: { nope: "^1.0.0" } });
    runCappedMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "E404 not found\n" }));

    const warning = await ensureWorkspaceDependencies(dir, opts());

    expect(warning).toContain("Could not install nope");
    expect(warning).toContain("E404 not found");
  });

  test("a killed install names the signal rather than reporting silence", async () => {
    await manifest({ dependencies: { nope: "^1.0.0" } });
    runCappedMock.mockResolvedValue(npmResult({ signal: "SIGTERM", stdout: "" }));

    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toContain("SIGTERM");
  });

  test("a spawn that throws is a warning, never a rejection", async () => {
    await manifest({ dependencies: { nope: "^1.0.0" } });
    runCappedMock.mockRejectedValue(new Error("npm: not found"));

    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toContain("npm: not found");
  });

  test("a nonzero exit that still installed the package is not reported as a failure", async () => {
    // npm exits nonzero on a lifecycle-script failure after the package is on
    // disk; whether the import resolves is the question, not the exit code.
    await manifest({ dependencies: { ms: "^2.1.3" } });
    runCappedMock.mockImplementation(async () => {
      await installedShared("ms");
      return npmResult({ exitCode: 1, stdout: "postinstall failed\n" });
    });

    await expect(ensureWorkspaceDependencies(dir, opts())).resolves.toBeNull();
  });

  test("a bad entry costs only itself — one npm run per missing package", async () => {
    // Staged together, npm resolves the manifest as a WHOLE and the bogus name
    // takes the good one down with it (verified against the real registry).
    await manifest({ dependencies: { ms: "^2.1.3", nope: "^9.9.9" } });
    runCappedMock.mockImplementation(async (_cmd, _args, o) => {
      const staged = await sharedDependencies();
      if ("ms" in staged) await installedShared("ms");
      expect(o.cwd).toBe(sharedRoot);
      return "nope" in staged
        ? npmResult({ exitCode: 1, stdout: "E404 not found\n" })
        : npmResult();
    });

    const warning = await ensureWorkspaceDependencies(dir, opts());

    expect(runCappedMock).toHaveBeenCalledTimes(2);
    expect(warning).toContain("Could not install nope");
    expect(warning).not.toContain("Could not install ms");
    // And the failure does not linger: left staged, it would be in the file
    // every LATER install reads, so one bad entry would permanently break
    // installing anything else in this sandbox.
    await expect(sharedDependencies()).resolves.toEqual({ ms: "^2.1.3" });
  });

  test("two overlapping builds install once, not twice", async () => {
    // A Publish can start while the chat's test_agent build is running. npm
    // takes no lock of its own, so both the staged manifest and node_modules
    // would be raced — and the second install is pure cost once the first has
    // already satisfied the tree.
    await manifest({ dependencies: { ms: "^2.1.3" } });
    runCappedMock.mockImplementation(async () => {
      await installedShared("ms");
      return npmResult();
    });

    const results = await Promise.all([
      ensureWorkspaceDependencies(dir, opts()),
      ensureWorkspaceDependencies(dir, opts()),
    ]);

    expect(results).toEqual([null, null]);
    expect(runCappedMock).toHaveBeenCalledOnce();
  });

  test("a refused spec is reported even when nothing needed installing", async () => {
    await manifest({ dependencies: { a: "file:../secrets" } });

    const warning = await ensureWorkspaceDependencies(dir, opts());

    expect(warning).toContain("Skipped a:");
    expect(runCappedMock).not.toHaveBeenCalled();
  });
});

describe("withDependencyWarning", () => {
  test("puts the warning ahead of the failure it likely caused", () => {
    expect(withDependencyWarning("could not install ms", "Build failed")).toBe(
      "could not install ms\n\nBuild failed",
    );
  });

  test("leaves a failure alone when there is no warning", () => {
    expect(withDependencyWarning(null, "Build failed")).toBe("Build failed");
  });
});
