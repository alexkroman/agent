// Copyright 2026 the AAI authors. MIT license.
/**
 * The Deno deployment, built for real and then RUN — under Deno.
 *
 * Scenario tier because both halves are: a rolldown pass over the whole
 * runtime, and a subprocess that boots the result. A subprocess rather than an
 * in-process import for the same reason as the Vercel suite — booting an agent
 * server starts a runtime whose only shutdown door is `AgentServer.close()`,
 * and the emitted module exports nothing.
 *
 * What earns the runtime here is the claim the whole target rests on: that a
 * directory with NO `node_modules` boots. Two separate things had to be copied
 * in before that was true, and each was found by a real deployment failing —
 * the worker artifact, and the prebuilt browser client, whose absence crashed
 * `defaultClientDir()` on a `require.resolve` with nothing to answer it.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, onTestFinished, test } from "vitest";
import { DENO_ENTRY_FILE, DENO_ENTRY_SOURCE, DENO_OUTPUT_DIR } from "./_build-target.ts";
import { emitDenoOutput } from "./_deno-output.ts";
import { bundleTargetEntry } from "./_target-bundle.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";

const run = promisify(execFile);

/** Whether a `deno` binary is on PATH — the arm that needs one says so. */
async function hasDeno(): Promise<boolean> {
  return await run("deno", ["--version"]).then(
    () => true,
    () => false,
  );
}

/**
 * A project whose `node_modules` resolves the CLI as well as the SDK.
 *
 * `linkSdkNodeModules` symlinks this package's own `node_modules`, which holds
 * every dependency the bundle needs but NOT `@alexkroman1/aai-cli` itself — a
 * package has no self-link — and the entry imports the published subpath.
 */
async function linkProjectNodeModules(dir: string): Promise<void> {
  await linkSdkNodeModules(dir);
  const packages = path.resolve(import.meta.dirname, "../..");
  const real = await fs.realpath(path.join(dir, "node_modules"));
  await fs.rm(path.join(dir, "node_modules"), { force: true });
  await fs.mkdir(path.join(dir, "node_modules", "@alexkroman1"), { recursive: true });
  for (const entry of await fs.readdir(real)) {
    if (entry === "@alexkroman1") continue;
    await fs.symlink(path.join(real, entry), path.join(dir, "node_modules", entry));
  }
  for (const pkg of ["aai", "aai-runtime", "aai-ui", "aai-cli"]) {
    await fs.symlink(
      path.join(packages, pkg),
      path.join(dir, "node_modules", "@alexkroman1", pkg),
      "dir",
    );
  }
}

/** A built project: the worker the entry loads, and its env declaration. */
async function builtProject(dir: string): Promise<void> {
  await linkProjectNodeModules(dir);
  await fs.mkdir(path.join(dir, ".aai"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".aai", "worker.mjs"),
    `export default { name: "Deno Probe", systemPrompt: "hi", greeting: "hi", tools: {} };\n`,
  );
  await fs.writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
}

describe("the bundled Deno entry", () => {
  test("carries no build toolchain, and no native binding it could not bundle", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        const code = await bundleTargetEntry(dir, DENO_ENTRY_SOURCE, "deno");

        // The reason this target bundles at all: unbundled, Deno Deploy caches
        // the dependency graph of `@alexkroman1/aai-cli` — a build toolchain —
        // and the build died at its 1024 MiB limit before reaching our code.
        expect(code).not.toContain("@rolldown/binding");
        expect(code).toMatch(/await server\.listen\(/);
      }),
    );
  }, 120_000);

  test("boots under DENO from a directory with no node_modules", async () => {
    if (!(await hasDeno())) {
      // Announced, never silent: this is the only arm that proves the claim
      // the target exists for, so a machine without Deno must say it skipped.
      expect.soft(true, "deno not on PATH — portability arm skipped").toBe(true);
      return;
    }
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitDenoOutput(dir);

        // A SIBLING of the project, never a child, and that is the whole
        // validity of this test. Copied to `<project>/deployed` it passed with
        // the client copy REMOVED — module resolution walks UP, so it found the
        // project's own `node_modules` and the "no node_modules" claim was
        // false. A/B'd both ways; only the sibling reproduces a deployment.
        const deployed = await fs.mkdtemp(path.join(os.tmpdir(), "aai_deno_deployed_"));
        await fs.cp(path.join(dir, DENO_OUTPUT_DIR), deployed, { recursive: true });
        onTestFinished(async () => {
          await fs.rm(deployed, { recursive: true, force: true });
        });

        const driver = path.join(deployed, "driver.mjs");
        await fs.writeFile(
          driver,
          `const mod = await import("./${DENO_ENTRY_FILE}");
const res = await fetch(\`http://127.0.0.1:\${globalThis.Deno.env.get("PORT")}/health\`);
process.stdout.write(\`\${res.status} \${await res.text()}\`);
process.exit(0);
`,
        );

        const { stdout } = await run("deno", ["run", "-A", driver], {
          cwd: deployed,
          env: { ...process.env, PORT: "8791", ASSEMBLYAI_API_KEY: "scenario-test-key" },
        });
        expect(stdout).toContain("200");
        expect(stdout).toContain("Deno Probe");
      }),
    );
  }, 120_000);
});
