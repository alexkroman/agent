// Copyright 2026 the AAI authors. MIT license.
// Reifying a workspace manifest: the missing-check (pure) and the install
// itself with the spawn mocked out — the same split
// studio-project-tools.test.ts / studio-project-tools-mocked.test.ts uses.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { npmResult, useTempDir } from "./_test-utils.ts";
import { runNpm } from "./studio-spawn.ts";
import {
  ensureWorkspaceDependencies,
  missingDependencies,
  withDependencyWarning,
} from "./studio-workspace-deps.ts";

vi.mock("./studio-spawn.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./studio-spawn.ts")>();
  return { ...mod, runNpm: vi.fn() };
});

const runNpmMock = vi.mocked(runNpm);

const workspace = useTempDir("aai-workspace-");
const toolchainDir = useTempDir("aai-toolchain-");

beforeEach(() => {
  // `restoreMocks` covers `vi.spyOn`, not a `vi.fn()` installed by a module
  // mock factory — without this, a previous test's implementation and call
  // count leak into the ones asserting npm was never spawned.
  runNpmMock.mockReset();
});

const opts = () => ({ toolchainModules: toolchainDir() });

/** Write the workspace manifest. */
const manifest = (contents: unknown): Promise<void> =>
  writeFile(path.join(workspace(), "package.json"), JSON.stringify(contents), "utf-8");

/** What a successful `npm install` leaves in the workspace. */
const installed = (name: string): Promise<string | undefined> =>
  mkdir(path.join(workspace(), "node_modules", name), { recursive: true });

/** Put `name` in the baked toolchainDir(), where a bare import resolves by walk-up. */
const inToolchain = (name: string): Promise<string | undefined> =>
  mkdir(path.join(toolchainDir(), name), { recursive: true });

/** npm succeeds and lands `name`'s files, as a real run would. */
const npmLands = (name: string, over: Partial<Awaited<ReturnType<typeof runNpm>>> = {}) =>
  runNpmMock.mockImplementation(async () => {
    await installed(name);
    return npmResult(over);
  });

describe("missingDependencies", () => {
  test("names the declared packages nothing can resolve", () => {
    expect(
      missingDependencies(
        { dependencies: { ms: "^2.1.3", react: "19.2.8" } },
        (n) => n === "react",
      ),
    ).toEqual(["ms"]);
  });

  test("ignores devDependencies — the toolchainDir() supplies those", () => {
    // A project pushed from a laptop carries the scaffold's whole toolchainDir()
    // block (vite, typescript, vitest); `--omit=dev` is why it stays out.
    expect(missingDependencies({ devDependencies: { vite: "^8.0.0" } }, () => false)).toEqual([]);
  });

  test("a manifest with no usable dependencies field reports nothing", () => {
    for (const value of [null, {}, { dependencies: null }, { dependencies: "nope" }, "not-json"]) {
      expect.soft(missingDependencies(value, () => false)).toEqual([]);
    }
  });
});

describe("ensureWorkspaceDependencies", () => {
  test("does not spawn npm when every declared package already resolves", async () => {
    await manifest({ dependencies: { ms: "^2.1.3", react: "19.2.8" } });
    await installed("ms");
    await inToolchain("react");

    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toBeNull();
    expect(runNpmMock).not.toHaveBeenCalled();
  });

  test("does not spawn npm when there is no manifest to reify", async () => {
    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toBeNull();
    expect(runNpmMock).not.toHaveBeenCalled();
  });

  test("installs in the WORKSPACE, omitting devDependencies", async () => {
    // In the workspace, not a shared tree one level up: the manifest declares
    // only this workspace's own packages, so npm reifying the whole of it is
    // exactly what we want (measured 451ms/28 KB against 25s/156 MB when the
    // platform's six were also declared).
    await manifest({ dependencies: { ms: "^2.1.3", react: "19.2.8" } });
    await inToolchain("react");
    npmLands("ms", { stdout: "added 1 package\n" });

    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toBeNull();
    expect(runNpmMock).toHaveBeenCalledWith(
      workspace(),
      ["install", "--omit=dev"],
      expect.any(Number),
    );
  });

  test("a package the toolchainDir() provides is never installed", async () => {
    // The platform owns these versions; a workspace-local copy would shadow
    // the baked one the harness resolved.
    await manifest({ dependencies: { "@alexkroman1/aai": "5.14.0" } });
    await inToolchain("@alexkroman1/aai");

    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toBeNull();
    expect(runNpmMock).not.toHaveBeenCalled();
  });

  test("an unresolvable toolchainDir() workspace() means nothing is provided", async () => {
    await manifest({ dependencies: { react: "19.2.8" } });
    runNpmMock.mockResolvedValue(npmResult());

    await ensureWorkspaceDependencies(workspace(), { toolchainModules: null });

    expect(runNpmMock).toHaveBeenCalledOnce();
  });

  test("reports what is still missing, with npm's output, when the install fails", async () => {
    await manifest({ dependencies: { nope: "^1.0.0" } });
    runNpmMock.mockResolvedValue(npmResult({ exitCode: 1, stdout: "E404 not found\n" }));

    const warning = await ensureWorkspaceDependencies(workspace(), opts());

    expect(warning).toContain("Could not install nope");
    expect(warning).toContain("E404 not found");
  });

  test("a nonzero exit whose package still landed is not a failure", async () => {
    // npm exits nonzero on a lifecycle-script failure after the files arrive.
    // Whether the import resolves is the question, not the exit code.
    await manifest({ dependencies: { ms: "^2.1.3" } });
    npmLands("ms", { exitCode: 1, stdout: "postinstall failed\n" });

    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toBeNull();
  });

  test("a killed install names the signal rather than reporting silence", async () => {
    await manifest({ dependencies: { nope: "^1.0.0" } });
    runNpmMock.mockResolvedValue(npmResult({ signal: "SIGTERM", stdout: "" }));

    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toContain("SIGTERM");
  });

  test("a spawn that throws is a warning, never a rejection", async () => {
    await manifest({ dependencies: { nope: "^1.0.0" } });
    runNpmMock.mockRejectedValue(new Error("npm: not found"));

    await expect(ensureWorkspaceDependencies(workspace(), opts())).resolves.toContain(
      "npm: not found",
    );
  });

  test("the budget the caller passes is the one npm gets", async () => {
    // session-init's host abandons it at 30s, and this runs on every page open.
    await manifest({ dependencies: { ms: "^2.1.3" } });
    npmLands("ms");

    await ensureWorkspaceDependencies(workspace(), { ...opts(), budgetMs: 20_000 });

    expect(runNpmMock).toHaveBeenCalledWith(workspace(), expect.any(Array), 20_000);
  });

  test("two overlapping builds install once, not twice", async () => {
    // npm takes no lock of its own, so two installs of the same directory
    // would race the tree; and the second is pure cost once the first landed.
    await manifest({ dependencies: { ms: "^2.1.3" } });
    npmLands("ms");

    const results = await Promise.all([
      ensureWorkspaceDependencies(workspace(), opts()),
      ensureWorkspaceDependencies(workspace(), opts()),
    ]);

    expect(results).toEqual([null, null]);
    expect(runNpmMock).toHaveBeenCalledOnce();
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
