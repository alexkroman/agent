// Copyright 2026 the AAI authors. MIT license.
/**
 * What `aai build --target deno` puts on disk.
 *
 * Every assertion is about a file being present or ABSENT, because that is the
 * failure class this emit exists to close. `deno deploy` uploads a directory
 * and runs one entrypoint in it with no install step, so a file the server
 * opens at run time and the emit did not copy is a deployment that builds
 * clean and dies at boot — which is how each of these was found. The
 * client-directory case is the sharpest: a bundled deployment with no
 * `node_modules` crashed in `defaultClientDir()`, on a
 * `require.resolve("@alexkroman1/aai-ui/package.json")` with nothing to answer
 * it.
 *
 * The bundler is stubbed; its own contract needs a real rolldown pass and
 * lives in `_deno-output.scenario.test.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { DENO_ENTRY_FILE, DENO_OUTPUT_DIR } from "./_build-target.ts";
import { emitDenoOutput } from "./_deno-output.ts";
import { withTempDir } from "./_test-utils.ts";

const STUB = "// bundled entry\n";
const stubBundle = () => Promise.resolve(STUB);

/** A project as `aai build` leaves it, minus whatever `absent` names. */
async function project(dir: string, absent: readonly string[] = []): Promise<void> {
  const files: Record<string, string> = {
    [WORKER_ARTIFACT_REL]: "export default { name: 'a' };",
    [path.join(CLIENT_ARTIFACT_REL, "index.html")]: "<!doctype html><title>built</title>",
    ".env.example": "ASSEMBLYAI_API_KEY=\n",
    ".env": "ASSEMBLYAI_API_KEY=sk-live-do-not-ship\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    if (absent.includes(rel)) continue;
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
}

const out = (dir: string, ...rel: string[]) => path.join(dir, DENO_OUTPUT_DIR, ...rel);
const read = (p: string) => fs.readFile(p, "utf-8");
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

describe("emitDenoOutput", () => {
  test("the entry sits at the path Deploy is pointed at", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // `DENO_ENTRY_FILE` is a contract with the `--entrypoint` a user passes
      // to `deno deploy`, so the constant and the file cannot drift.
      expect(await read(out(dir, DENO_ENTRY_FILE))).toBe(STUB);
    });
  });

  test("the worker travels, since no bundler can inline a dynamic import", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // Nested `.aai/` on purpose: `createProjectServer` resolves the worker at
      // `<cwd>/.aai/worker.mjs` and the entry passes its own directory as cwd.
      expect(await read(out(dir, WORKER_ARTIFACT_REL))).toContain("name: 'a'");
    });
  });

  test("`.env.example` ships and `.env` does NOT", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // The example DECLARES which variables become `ctx.env`; without it every
      // tool sees an empty env while the platform has the values set. `.env`
      // holds a developer's own keys — copying it would upload live credentials
      // and let them outrank what `deno deploy env` set.
      expect(await exists(out(dir, ".env.example"))).toBe(true);
      expect(await exists(out(dir, ".env"))).toBe(false);
    });
  });

  test("the project's own built client is carried", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      expect(await read(out(dir, CLIENT_ARTIFACT_REL, "index.html"))).toContain("built");
    });
  });

  test("a project with no client.tsx gets the SDK's prebuilt UI copied in", async () => {
    await withTempDir(async (dir) => {
      await project(dir, [path.join(CLIENT_ARTIFACT_REL, "index.html")]);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // The case that actually broke a deployment: with no `node_modules` on
      // the platform, falling back to `defaultClientDir()` at BOOT throws. The
      // fallback has to happen HERE, at emit time, where node_modules exists.
      const html = out(dir, CLIENT_ARTIFACT_REL, "index.html");
      expect(await exists(html)).toBe(true);
      expect(await read(html)).not.toContain("built");
    });
  });

  test("a previous build's output is REMOVED, not merged into", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      const stale = out(dir, "stale.mjs");
      await fs.mkdir(path.dirname(stale), { recursive: true });
      await fs.writeFile(stale, "throw new Error('stale')");
      await emitDenoOutput(dir, { bundle: stubBundle });
      // The directory is uploaded wholesale, so anything left behind deploys.
      expect(await exists(stale)).toBe(false);
    });
  });

  test("a project with no `.env` at all still emits", async () => {
    await withTempDir(async (dir) => {
      await project(dir, [".env"]);
      await expect(emitDenoOutput(dir, { bundle: stubBundle })).resolves.toBeUndefined();
    });
  });
});
