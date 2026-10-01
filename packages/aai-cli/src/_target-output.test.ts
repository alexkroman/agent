// Copyright 2026 the AAI authors. MIT license.
/**
 * What a self-contained target emit puts on disk.
 *
 * Every assertion is about a file being present or ABSENT, because that is the
 * failure class this emit exists to close. Both hosts that use it upload a
 * directory and run one file in it with no install step, so a file the server
 * opens at run time and the emit did not copy is a deployment that builds
 * clean and dies at boot — which is how each of these was found. The
 * client-directory case is the sharpest: a bundled deployment with no
 * `node_modules` crashed in `defaultClientDir()`, on a
 * `require.resolve("@alexkroman1/aai-ui/package.json")` with nothing to answer
 * it.
 *
 * Asserted against a SYNTHETIC target rather than through `deno` or `modal`,
 * which is what makes these the shared contract rather than one target's
 * behaviour observed twice. The two real emits assert only what they add.
 *
 * The bundler is stubbed; its own contract needs a real rolldown pass and
 * lives in the scenario tier.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { emitSelfContainedOutput, type SelfContainedTarget } from "./_target-output.ts";
import { withTempDir } from "./_test-utils.ts";

const STUB = "// bundled entry\n";
const stubBundle = () => Promise.resolve(STUB);

/** A target that is nobody's host, so these cases cannot lean on one's quirks. */
const TARGET: SelfContainedTarget = {
  outputDir: path.join(".aai", "probe"),
  entryFile: "server.mjs",
  entrySource: "// probe entry source\n",
  name: "probe",
};

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

const emit = (dir: string) => emitSelfContainedOutput(dir, TARGET, { bundle: stubBundle });
const out = (dir: string, ...rel: string[]) => path.join(dir, TARGET.outputDir, ...rel);
const read = (p: string) => fs.readFile(p, "utf-8");
const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

describe("emitSelfContainedOutput", () => {
  test("the entry sits at the path the host is pointed at", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      // `entryFile` is a contract with whatever names the entrypoint — a
      // `deno deploy --entrypoint`, or the `node` argv in a generated app.py —
      // so the declaration and the file cannot drift.
      expect(await read(out(dir, TARGET.entryFile))).toBe(STUB);
    });
  });

  test("answers the absolute output directory, for a target with more to write", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      // Modal writes `app.py` into this path. Returning it is what keeps that
      // emit from recomputing where "here" is and being able to disagree.
      expect(await emit(dir)).toBe(path.join(dir, TARGET.outputDir));
    });
  });

  test("the worker travels, since no bundler can inline a dynamic import", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      // Nested `.aai/` on purpose: `createProjectServer` resolves the worker at
      // `<cwd>/.aai/worker.mjs` and every entry passes its own directory as cwd.
      expect(await read(out(dir, WORKER_ARTIFACT_REL))).toContain("name: 'a'");
    });
  });

  test("`.env.example` ships and `.env` does NOT", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      // The example DECLARES which variables become `ctx.env`; without it every
      // tool sees an empty env while the host has the values set. `.env` holds a
      // developer's own keys — copying it would upload live credentials and let
      // them outrank whatever the host was configured with.
      expect(await exists(out(dir, ".env.example"))).toBe(true);
      expect(await exists(out(dir, ".env"))).toBe(false);
    });
  });

  test("the project's own built client is carried", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      expect(await read(out(dir, CLIENT_ARTIFACT_REL, "index.html"))).toContain("built");
    });
  });

  test("a project with no built client gets the SDK's prebuilt UI copied in", async () => {
    await withTempDir(async (dir) => {
      await project(dir, [path.join(CLIENT_ARTIFACT_REL, "index.html")]);
      await emit(dir);
      // The case that actually broke a deployment: with no `node_modules` on
      // the host, falling back to `defaultClientDir()` at BOOT throws. The
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
      await emit(dir);
      // The directory is uploaded wholesale, so anything left behind deploys —
      // and for Modal it is baked into an image layer, which cannot be unpushed.
      expect(await exists(stale)).toBe(false);
    });
  });

  test("a project with no `.env` at all still emits", async () => {
    await withTempDir(async (dir) => {
      await project(dir, [".env"]);
      await expect(emit(dir)).resolves.toBe(path.join(dir, TARGET.outputDir));
    });
  });

  test("the default bundler is only reached when none is injected", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      let sawSource: string | undefined;
      await emitSelfContainedOutput(dir, TARGET, {
        bundle: (cwd) => {
          sawSource = cwd;
          return Promise.resolve(STUB);
        },
      });
      // The injected bundler gets the PROJECT directory, not the output one:
      // the entry imports `@alexkroman1/aai-cli/start`, which resolves against
      // the user's own install and nowhere else.
      expect(sawSource).toBe(dir);
    });
  });
});
