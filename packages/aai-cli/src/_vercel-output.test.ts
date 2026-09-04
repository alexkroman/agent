// Copyright 2026 the AAI authors. MIT license.
/**
 * What `aai build --target vercel` puts on disk.
 *
 * Every assertion here is about a file being present or ABSENT, because that
 * is the entire failure class the Build Output API was adopted to close: the
 * previous `api/` shape produced a green build and a function that 500'd on
 * its first request, since the two files the server reads at runtime are
 * reached by paths no static tracer can follow. A test that only checked the
 * happy directory would not have caught it either — so the copies are asserted
 * by CONTENT, and `.env` is asserted to be missing.
 *
 * The bundler is stubbed. Its own contract (that the entry compiles, boots,
 * and does not drag the build toolchain in) needs a real rolldown pass and
 * lives in `_vercel-output.scenario.test.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { VERCEL_FUNCTION_DIR, VERCEL_OUTPUT_DIR, VERCEL_STATIC_DIR } from "./_build-target.ts";
import { withTempDir } from "./_test-utils.ts";
import { emitVercelOutput } from "./_vercel-output.ts";

const STUB = "export default function handler() {}\n";
const stubBundle = () => Promise.resolve(STUB);

/** A project as `aai build` leaves it, minus whatever `absent` names. */
async function project(dir: string, absent: readonly string[] = []): Promise<void> {
  const files: Record<string, string> = {
    ".aai/worker.mjs": "export default { name: 'a' };",
    ".aai/client/index.html": "<!doctype html><title>built</title>",
    ".aai/client/assets/app.js": "console.log(1)",
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

const read = (dir: string, rel: string) => fs.readFile(path.join(dir, rel), "utf-8");
const exists = (dir: string, rel: string) =>
  fs.stat(path.join(dir, rel)).then(
    () => true,
    () => false,
  );

describe("emitVercelOutput", () => {
  test("the function carries the worker artifact, which no tracer could find", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitVercelOutput(dir, { bundle: stubBundle });

      // `start.ts` loads this through `import(pathToFileURL(...))`. Under the
      // `api/` shape @vercel/nft could not see it, the build was green, and the
      // function failed on its first request with "No built agent".
      expect(await read(dir, path.join(VERCEL_FUNCTION_DIR, ".aai", "worker.mjs"))).toContain(
        "name: 'a'",
      );
      expect(await read(dir, path.join(VERCEL_FUNCTION_DIR, "index.mjs"))).toBe(STUB);
    });
  });

  test("`.env.example` ships and `.env` does NOT", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitVercelOutput(dir, { bundle: stubBundle });

      // The example is the DECLARATION of which variables become `ctx.env`, so
      // a function without it hands every tool an empty env while the platform
      // has the values set. `.env` holds a developer's own keys: copying it
      // bakes live credentials into a deployment artifact AND lets them win
      // over the Vercel project's values.
      expect(await exists(dir, path.join(VERCEL_FUNCTION_DIR, ".env.example"))).toBe(true);
      expect(await exists(dir, path.join(VERCEL_FUNCTION_DIR, ".env"))).toBe(false);
    });
  });

  test("a project with no `.env` at all still emits", async () => {
    await withTempDir(async (dir) => {
      await project(dir, [".env"]);
      await expect(emitVercelOutput(dir, { bundle: stubBundle })).resolves.toBeUndefined();
    });
  });

  test("the built client is CDN-served and also reachable from the function", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitVercelOutput(dir, { bundle: stubBundle });

      // Static, because `handle: filesystem` runs first and an asset that
      // reaches the function costs an invocation for a file.
      expect(await read(dir, path.join(VERCEL_STATIC_DIR, "index.html"))).toContain("built");
      expect(await exists(dir, path.join(VERCEL_STATIC_DIR, "assets", "app.js"))).toBe(true);
      // And beside the worker, so `resolveClientDir` finds a real directory
      // rather than reaching into a `node_modules` the bundle replaced.
      expect(
        await exists(dir, path.join(VERCEL_FUNCTION_DIR, ".aai", "client", "index.html")),
      ).toBe(true);
    });
  });

  test("a project with no client.tsx falls back to the SDK's prebuilt UI", async () => {
    await withTempDir(async (dir) => {
      await project(dir, [".aai/client/index.html", ".aai/client/assets/app.js"]);
      await emitVercelOutput(dir, { bundle: stubBundle });

      // Same choice `resolveClientDir` makes at boot, made once here so the two
      // copies cannot disagree about which UI this deployment serves.
      expect(await read(dir, path.join(VERCEL_STATIC_DIR, "index.html"))).not.toContain("built");
      expect(await exists(dir, path.join(VERCEL_STATIC_DIR, "index.html"))).toBe(true);
    });
  });

  test("a previous build's output is REMOVED, not merged into", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      const stale = path.join(dir, VERCEL_OUTPUT_DIR, "functions", "old.func", "index.mjs");
      await fs.mkdir(path.dirname(stale), { recursive: true });
      await fs.writeFile(stale, "throw new Error('stale')");

      await emitVercelOutput(dir, { bundle: stubBundle });

      // `vercel deploy --prebuilt` uploads whatever is in the directory, and
      // the directory is not addressed by content: a function left by a build
      // with a different shape would be deployed alongside this one.
      expect(await exists(dir, path.join(VERCEL_OUTPUT_DIR, "functions", "old.func"))).toBe(false);
    });
  });

  test("the routing table and the function config are written where Vercel reads them", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitVercelOutput(dir, { bundle: stubBundle });

      const config = JSON.parse(await read(dir, path.join(VERCEL_OUTPUT_DIR, "config.json")));
      expect(config.version).toBe(3);
      const vc = JSON.parse(await read(dir, path.join(VERCEL_FUNCTION_DIR, ".vc-config.json")));
      // The handler name is a contract between these two files and the bundle
      // written above: the launcher loads `.vc-config.json`'s `handler`.
      expect(vc.handler).toBe("index.mjs");
      expect(await exists(dir, path.join(VERCEL_FUNCTION_DIR, vc.handler))).toBe(true);
    });
  });
});
