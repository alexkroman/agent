// Copyright 2026 the AAI authors. MIT license.
/**
 * The Vercel function bundle, built for real and then RUN.
 *
 * Scenario tier because both halves are: a rolldown pass over the whole
 * runtime, and a subprocess that boots the result. A subprocess rather than an
 * in-process import deliberately — booting an agent server starts a runtime
 * whose only shutdown door is `AgentServer.close()`, and the emitted module
 * exports a handler and not the server, so an in-process boot would leak
 * timers and sockets into the rest of the suite.
 *
 * The assertion that earns the runtime is the one about the BUILD TOOLCHAIN.
 * `@alexkroman1/aai-cli/start` sits in a package whose other half is the
 * bundler, and for one release its published chunk graph reached
 * `build.ts` — hence vite, hence rolldown — for a single one-line path
 * constant. Nothing failed at build time: the bundle came out 16 MB and died
 * on import with `Cannot find module '@rolldown/binding-darwin-universal'`,
 * because a native binding is exactly what cannot be bundled. `_artifacts.ts`
 * exists to keep that edge cut, and this is what notices if it grows back.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { bundleTargetEntry } from "./_target-bundle.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";
import { emitVercelOutput } from "./_vercel-output.ts";
import { VERCEL_ENTRY_SOURCE, VERCEL_FUNCTION_DIR } from "./_vercel-target.ts";

const run = promisify(execFile);

/**
 * A project whose `node_modules` resolves the CLI as well as the SDK.
 *
 * `linkSdkNodeModules` symlinks this package's own `node_modules`, which holds
 * every dependency the bundle needs but NOT `@alexkroman1/aai-cli` itself — a
 * package has no self-link. The emitted entry imports the published subpath,
 * so the scope directory is rebuilt here as real symlinks with the CLI added.
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

/** A built project: the worker artifact the entry loads, and its env declaration. */
async function builtProject(dir: string): Promise<void> {
  await linkProjectNodeModules(dir);
  await fs.mkdir(path.join(dir, ".aai"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".aai", "worker.mjs"),
    `export default { name: "Bundle Probe", systemPrompt: "hi", greeting: "hi", tools: {} };\n`,
  );
  await fs.writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
}

describe("the bundled Vercel function", () => {
  test("carries no build toolchain, and no native binding it could not bundle", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        const code = await bundleTargetEntry(dir, VERCEL_ENTRY_SOURCE, "vercel");

        // The failure this pins is not a size regression, it is an import-time
        // crash: a `.node` binding cannot be inlined, so reaching one at all
        // means the bundle does not load.
        expect(code).not.toContain("@rolldown/binding");
        expect(code).toContain("export { handler as default }");
        // Resolved from the module, not the process: `.aai/` was copied in
        // beside it, and the working directory belongs to the platform.
        expect(code).toContain("import.meta.dirname");
      }),
    );
  }, 120_000);

  test("boots from the emitted directory and serves the HTTP surface", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitVercelOutput(dir);

        // Stands in for Vercel's Node launcher, which invokes the module's
        // default export per request. Run from the function directory, since
        // that is the layout the entry resolves `.aai/worker.mjs` against.
        const driver = path.join(dir, VERCEL_FUNCTION_DIR, "driver.mjs");
        await fs.writeFile(
          driver,
          `import http from "node:http";
const { default: handler } = await import("./index.mjs");
const s = http.createServer(handler);
s.listen(0, "127.0.0.1", async () => {
  const r = await fetch(\`http://127.0.0.1:\${s.address().port}/health\`);
  process.stdout.write(\`\${r.status} \${await r.text()}\`);
  process.exit(0);
});
`,
        );

        const { stdout } = await run(process.execPath, [driver], {
          cwd: path.dirname(driver),
          // The value a Vercel project supplies. `.env.example` is what
          // DECLARES the name; without the declaration this never reaches the
          // agent, which is the packaging bug the unit tests cover.
          env: { ...process.env, ASSEMBLYAI_API_KEY: "scenario-test-key" },
        });

        expect(stdout).toContain("200");
        expect(stdout).toContain("Bundle Probe");
      }),
    );
  }, 120_000);
});
