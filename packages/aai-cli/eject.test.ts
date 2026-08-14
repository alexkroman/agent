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

const { executeEject, PRESTART_SCRIPT, SERVER_ENTRY, START_SCRIPT } = await import("./eject.ts");

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
      // Both scripts: the entrypoint boots the BUILT worker, so a `start` with
      // no `prestart` in front of it exits naming the missing artifact.
      expect((await readManifest(cwd)).scripts).toMatchObject({
        prestart: PRESTART_SCRIPT,
        start: START_SCRIPT,
      });
      if (result.ok) expect(result.data.addedScripts).toBe(true);
    });
  });

  test("the scripts it writes are the scaffold's own", async () => {
    // The one thing eject cannot copy: a project's package.json is its own, so
    // these two constants are a SECOND definition of the scaffold's scripts.
    // Drift means a freshly scaffolded project and an ejected one boot
    // differently — and the `prestart` half is what makes either boot at all.
    const scaffold = JSON.parse(
      await fs.readFile(path.join(REAL_TEMPLATES_ROOT, "scaffold", "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };
    expect(scaffold.scripts).toMatchObject({
      prestart: PRESTART_SCRIPT,
      start: START_SCRIPT,
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

      const scripts = (await readManifest(cwd)).scripts;
      expect(scripts?.start).toBe("node other.mjs");
      // And NO prestart: bolting a build onto someone else's start command
      // changes what that command does, which is the act this rule refuses.
      expect(scripts?.prestart).toBeUndefined();
      expect(result.ok && result.data.addedScripts).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining("node other.mjs"));
    });
  });

  test("backfills prestart for a project ejected before the build was required", async () => {
    // `start` is already right and `prestart` is missing — the shape an older
    // `aai eject` left behind. The entrypoint this run just wrote boots the
    // built worker, so without the backfill `npm start` exits immediately.
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir, { scripts: { start: START_SCRIPT } });

      const result = await executeEject({ cwd });

      expect((await readManifest(cwd)).scripts?.prestart).toBe(PRESTART_SCRIPT);
      expect(result.ok && result.data.addedScripts).toBe(true);
      expect(mockLog.warn).not.toHaveBeenCalled();
    });
  });

  test("leaves an already-correct script pair alone", async () => {
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir, {
        scripts: { prestart: PRESTART_SCRIPT, start: START_SCRIPT },
      });

      const result = await executeEject({ cwd });

      expect(result.ok && result.data.addedScripts).toBe(false);
      expect(mockLog.warn).not.toHaveBeenCalled();
    });
  });

  test("still writes the entrypoint when there is no package.json to edit", async () => {
    await withTempDir(async (dir) => {
      const cwd = await writeFiles(path.join(dir, "project"), {
        "agent.ts": 'export default { name: "test" };',
      });

      const result = await executeEject({ cwd });

      expect(result.ok && result.data.addedScripts).toBe(false);
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

  test("tells the user the start it just wired up builds first", async () => {
    // This used to be a client.tsx-specific hint ("run `aai build` first so
    // your UI is served"). It is unconditional now because the build is: the
    // entrypoint cannot boot without one, and the same build produces the
    // client.
    await withTempDir(async (dir) => {
      const cwd = await makeProject(dir);

      await executeEject({ cwd });

      expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining(PRESTART_SCRIPT));
    });
  });
});
