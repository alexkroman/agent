// Copyright 2026 the AAI authors. MIT license.
/**
 * What `aai build --target deno` puts on disk that is DENO's.
 *
 * The runtime files — the worker, the browser client, `.env.example`, and the
 * `.env` that must not travel — are the shared assembly and are asserted in
 * `_target-output.test.ts`, against a synthetic target so those claims are the
 * contract both self-contained emits rest on rather than this one target's
 * behaviour observed once.
 *
 * What is left here is Deno's own two files: the entry `deno deploy` runs, and
 * the `deno.json` that means no command against the directory has to re-supply
 * `--entrypoint`.
 *
 * The bundler is stubbed; its own contract needs a real rolldown pass and
 * lives in `_deno-output.scenario.test.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import {
  DENO_CONFIG_FILE,
  DENO_ENTRY_FILE,
  DENO_OUTPUT_DIR,
  MODAL_APP_FILE,
} from "./_build-target.ts";
import { emitDenoOutput } from "./_deno-output.ts";
import { withTempDir } from "./_test-utils.ts";

const STUB = "// bundled entry\n";
const stubBundle = () => Promise.resolve(STUB);

/** A project as `aai build` leaves it. */
async function project(dir: string): Promise<void> {
  const files: Record<string, string> = {
    [WORKER_ARTIFACT_REL]: "export default { name: 'a' };",
    [path.join(CLIENT_ARTIFACT_REL, "index.html")]: "<!doctype html><title>built</title>",
    ".env.example": "ASSEMBLYAI_API_KEY=\n",
  };
  for (const [rel, body] of Object.entries(files)) {
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
  test("the entry sits at the path Deploy is pointed at, under Deno's own directory", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // Both constants are contracts with the `deno deploy` invocation a user
      // runs, so neither may drift from what the emit actually writes.
      expect(await read(out(dir, DENO_ENTRY_FILE))).toBe(STUB);
    });
  });

  test("a `deno.json` describes how to run the directory", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // The point is that no command against this directory has to re-supply
      // the entrypoint, so the task has to NAME the entry this emit wrote —
      // a `deno.json` pointing at a file that is not there is worse than none.
      const config: unknown = JSON.parse(await read(out(dir, DENO_CONFIG_FILE)));
      expect(config).toEqual({ tasks: { start: `deno run -A ./${DENO_ENTRY_FILE}` } });
      expect(await exists(out(dir, DENO_ENTRY_FILE))).toBe(true);
    });
  });

  test("the descriptor it writes is Deno's own, and no other host's", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emitDenoOutput(dir, { bundle: stubBundle });
      // Both self-contained targets say what to RUN, and the two hosts take it
      // differently — a config Deno already understands, against a generated
      // Python module for Modal. A stray `app.py` here would mean the two emits
      // had been collapsed too far.
      const written = await fs.readdir(out(dir));
      expect(written).toContain(DENO_CONFIG_FILE);
      expect(written).not.toContain(MODAL_APP_FILE);
      expect(written.some((name) => name.endsWith(".py"))).toBe(false);
      expect(written).not.toContain("vercel.json");
    });
  });

  test("a project with no `.env` at all still emits", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await expect(emitDenoOutput(dir, { bundle: stubBundle })).resolves.toBeUndefined();
    });
  });
});
