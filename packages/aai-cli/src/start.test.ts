// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai start` — what it loads, and what it says when there is nothing to load.
 *
 * The two halves that need no socket. `executeStart` binds a port and
 * `createProjectServer` opens provider links, so both belong to a tier that may
 * do that: `_vercel-output.scenario.test.ts` boots the emitted bundle in a
 * subprocess and asserts it serves `/health`, which is `createProjectServer`
 * end to end.
 *
 * What is here is `loadBuiltAgent`, and it is worth its own test because its
 * FAILURE is the one a user meets: `npm start` before a build, where the
 * difference between a useful message and a stack trace about a missing module
 * is the whole of the experience.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { withTempDir } from "./_test-utils.ts";
import { CLIENT_ARTIFACT_REL, DEFAULT_START_PORT, loadBuiltAgent } from "./start.ts";

describe("loadBuiltAgent", () => {
  test("names the artifact and the command that produces it", async () => {
    await withTempDir(async (dir) => {
      // Not a MODULE_NOT_FOUND from deep inside an import: an unbuilt project
      // is the ordinary state of a fresh clone, so the message has to say what
      // to run.
      await expect(loadBuiltAgent(dir)).rejects.toThrow(WORKER_ARTIFACT_REL);
      await expect(loadBuiltAgent(dir)).rejects.toThrow(/aai build/);
    });
  });

  test("returns the built worker's DEFAULT export", async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(path.join(dir, ".aai"), { recursive: true });
      await fs.writeFile(
        path.join(dir, WORKER_ARTIFACT_REL),
        `export default { name: "Loaded Agent", systemPrompt: "hi", tools: {} };\n`,
      );
      const agent = await loadBuiltAgent(dir);
      expect(agent.name).toBe("Loaded Agent");
    });
  });

  test("imports through a file: URL, so a Windows path is a legal specifier", async () => {
    await withTempDir(async (dir) => {
      // The artifact path is absolute, and on Windows `C:\…` is not a valid
      // module specifier — `pathToFileURL` is what makes it one. Asserted by
      // loading from a directory whose name needs encoding, which is the same
      // property from the direction a POSIX runner can see.
      const nested = path.join(dir, "a project");
      await fs.mkdir(path.join(nested, ".aai"), { recursive: true });
      await fs.writeFile(
        path.join(nested, WORKER_ARTIFACT_REL),
        `export default { name: "Spaced", systemPrompt: "hi", tools: {} };\n`,
      );
      const agent = await loadBuiltAgent(nested);
      expect(agent.name).toBe("Spaced");
    });
  });
});

describe("the start defaults", () => {
  test("the port is 3000 and the client dir is under .aai", () => {
    // Both are published (`etc/start.api.md`), and both are what a deployment
    // reads when it configures nothing.
    expect(DEFAULT_START_PORT).toBe(3000);
    expect(CLIENT_ARTIFACT_REL).toBe(path.join(".aai", "client"));
  });
});
