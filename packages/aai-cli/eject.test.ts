// Copyright 2026 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeMockLog, withTempDir, writeFiles } from "./_test-utils.ts";

const mockLog = makeMockLog();
vi.mock("./_ui.ts", () => ({
  log: mockLog,
  notify: vi.fn(),
  silenceOutput: vi.fn(),
}));

// Resolution order is env override → monorepo → bundled; the monorepo branch
// would win in-tree and reach the same files, but pinning the override keeps
// the test independent of where it is run from.
vi.mock("./_agent.ts", () => ({
  isDevMode: vi.fn().mockReturnValue(false),
  getMonorepoRoot: vi.fn().mockReturnValue(null),
}));

const { executeEject, SERVER_ENTRY, START_SCRIPT } = await import("./eject.ts");

/** The real templates package — so these tests copy the scaffold users get. */
const REAL_TEMPLATES_ROOT = path.resolve(import.meta.dirname, "../aai-templates");

/** A project directory with an agent.ts and a package.json. */
async function makeProject(dir: string, manifest: object = {}): Promise<string> {
  return writeFiles(path.join(dir, "project"), {
    "agent.ts": 'export default { name: "test" };',
    "package.json": JSON.stringify(manifest),
  });
}

async function readManifest(cwd: string): Promise<{ scripts?: Record<string, string> }> {
  return JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"));
}

beforeEach(() => {
  // `restoreMocks` only covers vi.spyOn — the module-level log stub is plain
  // vi.fn()s, whose recorded calls would otherwise leak across tests.
  vi.clearAllMocks();
  vi.stubEnv("AAI_TEMPLATES_DIR", REAL_TEMPLATES_ROOT);
});

describe("executeEject", () => {
  test("writes the scaffold's entrypoint verbatim and adds the start script", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir);

      const result = await executeEject({ cwd });

      expect(result.ok).toBe(true);
      // Byte-identical to the scaffold's copy — the point of copying rather
      // than carrying a second definition of this file.
      const written = await fs.readFile(path.join(cwd, SERVER_ENTRY), "utf-8");
      const scaffolded = await fs.readFile(
        path.join(REAL_TEMPLATES_ROOT, "scaffold", SERVER_ENTRY),
        "utf-8",
      );
      expect(written).toBe(scaffolded);
      expect((await readManifest(cwd)).scripts?.start).toBe(START_SCRIPT);
      if (result.ok) expect(result.data.addedStartScript).toBe(true);
    });
  });

  test("refuses to clobber an existing server.mjs without --force", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir);
      await fs.writeFile(path.join(cwd, SERVER_ENTRY), "// mine\n");

      await expect(executeEject({ cwd })).rejects.toThrow(/already exists/);
      expect(await fs.readFile(path.join(cwd, SERVER_ENTRY), "utf-8")).toBe("// mine\n");
    });
  });

  test("--force replaces it and reports the overwrite", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir);
      await fs.writeFile(path.join(cwd, SERVER_ENTRY), "// mine\n");

      const result = await executeEject({ cwd, force: true });

      expect(result.ok && result.data.overwritten).toBe(true);
      expect(await fs.readFile(path.join(cwd, SERVER_ENTRY), "utf-8")).not.toBe("// mine\n");
    });
  });

  test("keeps an existing start script rather than rewriting how the project boots", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir, { scripts: { start: "node other.mjs" } });

      const result = await executeEject({ cwd });

      expect((await readManifest(cwd)).scripts?.start).toBe("node other.mjs");
      expect(result.ok && result.data.addedStartScript).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("node other.mjs"));
    });
  });

  test("leaves an already-correct start script alone", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir, { scripts: { start: START_SCRIPT } });

      const result = await executeEject({ cwd });

      expect(result.ok && result.data.addedStartScript).toBe(false);
      expect(mockLog.warn).not.toHaveBeenCalled();
    });
  });

  test("still writes the entrypoint when there is no package.json to edit", async () => {
    await withTempDir(async (dir) => {
      const cwd = await writeFiles(path.join(dir, "project"), {
        "agent.ts": 'export default { name: "test" };',
      });

      const result = await executeEject({ cwd });

      expect(result.ok && result.data.addedStartScript).toBe(false);
      expect(await fs.readFile(path.join(cwd, SERVER_ENTRY), "utf-8")).toContain(
        "createAgentServer",
      );
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("No package.json"));
    });
  });

  test("names the file and the directory when the scaffold is unreadable", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir);
      vi.stubEnv("AAI_TEMPLATES_DIR", path.join(dir, "nowhere"));

      await expect(executeEject({ cwd })).rejects.toThrow(
        new RegExp(`Could not read the scaffold's ${SERVER_ENTRY}`),
      );
    });
  });

  test("points a project with a custom UI at the build it needs", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir);
      await fs.writeFile(path.join(cwd, "client.tsx"), "// ui\n");

      await executeEject({ cwd });

      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining("aai build"));
    });
  });
});
