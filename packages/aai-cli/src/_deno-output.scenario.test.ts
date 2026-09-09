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
 * What earns the runtime here is the one claim only `deno` can settle: that the
 * emitted module GRAPH has nothing left to resolve. `deno info` walks a graph
 * instead of executing it, which is why booting the directory cannot make this
 * claim and why the gate is a graph walk.
 *
 * ## Booting it is `_target-runtimes.scenario.test.ts`'s job now
 *
 * This suite used to boot the directory and drain it on SIGTERM as well, and
 * the emit it booted is the shared one — `_target-entry.test.ts` pins the Deno
 * entry to the same body as Modal's, modulo a banner and a port. So those two
 * arms were one host's observation of a property that belongs to the ARTIFACT,
 * and they now run there against `node`, `deno` and `bun` in turn, off ONE
 * bundle. What stayed here is Deno's own: the graph, and the `deno.json` that
 * makes the directory runnable by hand.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, onTestFinished, test } from "vitest";
import { emitDenoOutput } from "./_deno-output.ts";
import {
  DENO_CONFIG_FILE,
  DENO_ENTRY_FILE,
  DENO_ENTRY_SOURCE,
  DENO_OUTPUT_DIR,
} from "./_deno-target.ts";
import { bundleTargetEntry } from "./_target-bundle.ts";
import {
  type BinaryGate,
  describeWithBinary,
  linkProjectNodeModules,
  silenced,
  withTempDir,
} from "./_test-utils.ts";

const run = promisify(execFile);

/**
 * The gate: a real `deno`, or a skip that ANNOUNCES itself.
 *
 * `describeWithBinary` (`_test-utils.ts`) is the generalisation of the
 * `describeWithDeno` that used to live here — its doc carries the argument,
 * including the `expect.soft(true, …)` this suite shipped with, which was a
 * skip spelled as a pass over the only assertion the target rests on.
 */
const DENO: BinaryGate = {
  bin: "deno",
  requireEnv: "AAI_REQUIRE_DENO",
  howTo:
    "Install Deno (`brew install deno`, or `curl -fsSL https://deno.land/install.sh | sh`).\n" +
    "CI's integration-and-scenario job pins one via denoland/setup-deno.",
};

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

  test("carries no JSDoc, because a commented import() is a real dependency", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        const code = await bundleTargetEntry(dir, DENO_ENTRY_SOURCE, "deno");

        // A text assertion beside the graph one below, and it earns its place
        // by being the one that runs with no `deno` on PATH — this is the
        // cheap half of `JSDOC_FREE_COMMENTS`.
        expect(code).not.toContain("/**");

        // The two classes that STAY, asserted because dropping either is a
        // behaviour change rather than a cosmetic one: `@__PURE__` is an
        // instruction to the tree-shaker, and a legal comment is a licensing
        // obligation to the packages inlined here.
        expect(code).toContain("@__PURE__");
      }),
    );
  }, 120_000);

  test("lands where `deno.json`'s task says it will", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitDenoOutput(dir);

        // `deno task start` has to work in the directory that gets uploaded,
        // which is the only reason the config is emitted at all — so the task
        // has to name a file the BUNDLER really wrote. `_deno-output.test.ts`
        // asserts the same pairing over a stubbed bundle, which cannot tell you
        // that a real rolldown pass writes where the task looks; this needs no
        // `deno` and so runs on every machine.
        const config = JSON.parse(
          await fs.readFile(path.join(dir, DENO_OUTPUT_DIR, DENO_CONFIG_FILE), "utf-8"),
        ) as { tasks?: Record<string, string> };
        expect(config.tasks?.start).toContain(DENO_ENTRY_FILE);
        const entry = await fs.stat(path.join(dir, DENO_OUTPUT_DIR, DENO_ENTRY_FILE));
        expect(entry.size).toBeGreaterThan(1_000_000);
      }),
    );
  }, 120_000);
});

/**
 * The emitted directory copied to a SIBLING of the project, never a child, and
 * that is the whole validity of these tests. Copied to `<project>/deployed`
 * the boot case passed with the client copy REMOVED — module resolution walks
 * UP, so it found the project's own `node_modules` and the "no node_modules"
 * claim was false. A/B'd both ways; only the sibling reproduces a deployment.
 */
async function deployedCopy(dir: string): Promise<string> {
  const deployed = await fs.mkdtemp(path.join(os.tmpdir(), "aai_deno_deployed_"));
  await fs.cp(path.join(dir, DENO_OUTPUT_DIR), deployed, { recursive: true });
  onTestFinished(async () => {
    await fs.rm(deployed, { recursive: true, force: true });
  });
  return deployed;
}

describeWithBinary(DENO, "the emitted Deno output, read by Deno", () => {
  /**
   * The graph gate: the emit really has nothing left to resolve.
   *
   * The two tests below cannot make this claim, and the gap is not a matter of
   * coverage. `deno run` resolves a module when it EVALUATES it, so a specifier
   * sitting in a comment is never looked at — the emitted directory booted and
   * served all three routes while `deno info` on the same file reported nine
   * unresolvable dependencies. Boot-and-serve is blind to a dangling edge by
   * construction; only a graph walk sees one.
   *
   * Deno Deploy currently tolerates those edges (a bundle carrying all of them
   * deployed and served a voice session), so this gate is about the property
   * `app.py` advertises — a bundle with no imports left to resolve — rather
   * than about a host that is failing today. `@vercel/nft` walks a graph too.
   *
   * `--json` and the MODULES rather than the exit code, deliberately:
   * `deno info` reports an unresolvable dependency and still exits 0 (verified
   * against a three-line file whose only `import()` was inside a `@type`), so a
   * gate written as "the command succeeded" would assert nothing at all.
   */
  test("has a module graph with nothing left to resolve", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitDenoOutput(dir);
        const deployed = await deployedCopy(dir);

        const { stdout } = await run("deno", ["info", "--json", DENO_ENTRY_FILE], {
          cwd: deployed,
          // 12MB of bundle, and the graph is the whole point of the call.
          maxBuffer: 64 * 1024 * 1024,
        });
        const graph = JSON.parse(stdout) as {
          modules: { specifier: string; error?: string }[];
        };

        // Named rather than counted: the failure this exists for arrived as
        // nine specifiers from three sources (undici's JSDoc, html-to-text's,
        // and our OWN workflow docs' `{@link import("./step-generate-json.ts")}`),
        // and a bare `toBe(0)` would have said none of that.
        const unresolved = graph.modules
          .filter((m) => m.error !== undefined)
          .map((m) => `${m.specifier}: ${m.error}`);
        expect(unresolved).toEqual([]);

        // The graph was really walked, so an empty `modules` cannot pass as a
        // clean one.
        expect(graph.modules.length).toBeGreaterThan(1);
      }),
    );
  }, 120_000);
});
