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
 * What is here is `loadBuiltAgent` — worth its own test because its FAILURE is
 * the one a user meets, `npm start` before a build being the ordinary state of
 * a fresh clone — and `createProjectServer`, which BUILDS a server and binds
 * nothing, so it is reachable without a port. That is the seam a serverless
 * host is written against, and the reason it can be tested here at all.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { withTempDir } from "./_test-utils.ts";
import {
  CLIENT_ARTIFACT_REL,
  createProjectServer,
  DEFAULT_START_PORT,
  loadBuiltAgent,
} from "./start.ts";

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

/** A built project, ready for `createProjectServer`. */
async function builtProject(dir: string, withClient: boolean): Promise<void> {
  await fs.mkdir(path.join(dir, ".aai"), { recursive: true });
  await fs.writeFile(
    path.join(dir, WORKER_ARTIFACT_REL),
    `export default { name: "Served Agent", systemPrompt: "hi", greeting: "hey", maxSteps: 2, tools: {} };\n`,
  );
  // `.env.example` is the DECLARATION of what becomes `ctx.env` — see
  // `DEPLOY_ENV_FILES`. Without it the agent env is empty and provider
  // resolution fails, which is the packaging bug the vercel emit also hit.
  await fs.writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
  if (!withClient) return;
  await fs.mkdir(path.join(dir, CLIENT_ARTIFACT_REL), { recursive: true });
  await fs.writeFile(path.join(dir, CLIENT_ARTIFACT_REL, "index.html"), "<!doctype html>built");
}

describe("createProjectServer", () => {
  test("builds a server and binds NOTHING", async () => {
    await withTempDir(async (dir) => {
      await builtProject(dir, true);
      vi.stubEnv("ASSEMBLYAI_API_KEY", "unit-test-key");
      const server = await createProjectServer({ cwd: dir });
      onTestFinished(async () => {
        await server.close();
      });

      // The whole point of the seam: a host takes this and calls `listen`
      // itself, so nothing here may be listening and `port` must ask the
      // server rather than report a value `listen()` latched.
      expect(server.node.listening).toBe(false);
      expect(server.port).toBeUndefined();
    });
  });

  test("an UNBUILT client.tsx still boots, taking the warn path", async () => {
    await withTempDir(async (dir) => {
      await builtProject(dir, false);
      // A `client.tsx` with no build beside it is worth saying out loud — the
      // server would otherwise serve the default UI and look like it had
      // ignored the file. What is asserted is that it still BOOTS: the warning
      // is advice, not a refusal.
      await fs.writeFile(path.join(dir, "client.tsx"), "export default null;\n");
      vi.stubEnv("ASSEMBLYAI_API_KEY", "unit-test-key");
      const server = await createProjectServer({ cwd: dir });
      onTestFinished(async () => {
        await server.close();
      });
      expect(server.node.listening).toBe(false);
    });
  });

  test("falls back to the SDK's prebuilt UI when the project has none", async () => {
    await withTempDir(async (dir) => {
      await builtProject(dir, false);
      vi.stubEnv("ASSEMBLYAI_API_KEY", "unit-test-key");
      // The branch that matters is that it RESOLVES rather than throwing on a
      // project with no `client.tsx` build — the default client ships inside
      // `@alexkroman1/aai-ui`, so a missing install is a boot failure.
      const server = await createProjectServer({ cwd: dir });
      onTestFinished(async () => {
        await server.close();
      });
      expect(server.node).toBeDefined();
    });
  });
});
