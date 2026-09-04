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

import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  DENO_CONFIG_FILE,
  DENO_ENTRY_FILE,
  DENO_ENTRY_SOURCE,
  DENO_OUTPUT_DIR,
} from "./_build-target.ts";
import { emitDenoOutput } from "./_deno-output.ts";
import { bundleTargetEntry } from "./_target-bundle.ts";
import { linkSdkNodeModules, silenced, withTempDir } from "./_test-utils.ts";

const run = promisify(execFile);

/** Fence around the driver's JSON, so the server's startup banner cannot land inside it. */
const PROBE_START = "<<<aai-probes";
const PROBE_END = "aai-probes>>>";

/**
 * Whether a `deno` binary is on PATH.
 *
 * `spawnSync` at module scope rather than an `await` inside the test, and that
 * is the whole fix below: a probe awaited in a test BODY can only produce a
 * pass or a fail, never a skip, so the gate has to be decided at COLLECTION
 * time to be a gate at all.
 */
const HAVE_DENO = spawnSync("deno", ["--version"], { stdio: "ignore" }).status === 0;

const HOW_TO =
  "Install Deno (`brew install deno`, or `curl -fsSL https://deno.land/install.sh | sh`).\n" +
  "CI's integration-and-scenario job pins one via denoland/setup-deno.";

// Biome's `noSkippedTests` flags the `describe.skip(…)` CALL form, so the gated
// suite references it instead — exactly as `aai/host/ffmpeg.scenario.test.ts`
// and `_pg-test-utils.ts` do.
const skipSuite = describe.skip;

/**
 * A suite that needs a real Deno — and whose skip ANNOUNCES itself.
 *
 * This replaced an `expect.soft(true, "deno not on PATH …")` inside the test
 * body, which was a skip spelled as a PASS. Nothing in CI installed Deno, so
 * that case reported green on every leg — meaning the only test in the repo
 * that proves `aai build --target deno` emits a directory which BOOTS was
 * gated by nothing, on the branch that added the target. That is the shape
 * `AGENTS.md` names a gate reporting success over a comparison it could not
 * make.
 *
 * So it follows `describeWithFfmpeg` (`aai/host/ffmpeg.scenario.test.ts`),
 * which follows `describeWithPg`: skip loudly, and let **`AAI_REQUIRE_DENO`** —
 * which CI's scenario job sets only once `deno --version` really answered —
 * turn the skip into a hard failure, so a broken setup step cannot read as a
 * green run either.
 */
function describeWithDeno(name: string, body: () => void): void {
  if (HAVE_DENO) {
    describe(name, body);
    return;
  }
  if ((process.env.AAI_REQUIRE_DENO ?? "") !== "") {
    throw new Error(`AAI_REQUIRE_DENO is set but no deno was found.\n${HOW_TO}`);
  }
  console.warn(`\n[skipped: no deno] Deno portability arm not run.\n${HOW_TO}\n`);
  skipSuite(name, body);
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
});

describeWithDeno("the emitted Deno output, run under Deno", () => {
  test("boots from a directory with no node_modules", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitDenoOutput(dir);

        // `deno task start` has to work in the directory that gets uploaded,
        // which is the only reason the config is emitted at all.
        const task = JSON.parse(
          await fs.readFile(path.join(dir, DENO_OUTPUT_DIR, DENO_CONFIG_FILE), "utf-8"),
        ) as { tasks?: Record<string, string> };
        expect(task.tasks?.start).toContain(DENO_ENTRY_FILE);

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

        // Three routes rather than one, because BOOTING is not the claim —
        // serving out of this layout is. `/health` was all this asserted, and
        // it is the one route that reads nothing off disk, so the two failures
        // the emit exists to prevent (a worker that did not travel, a client
        // directory `defaultClientDir()` cannot resolve) were both invisible
        // to it. Probed in one process so the cost stays one boot.
        const driver = path.join(deployed, "driver.mjs");
        await fs.writeFile(
          driver,
          `const PROBE_START = ${JSON.stringify(PROBE_START)};
const PROBE_END = ${JSON.stringify(PROBE_END)};
await import("./${DENO_ENTRY_FILE}");
const base = \`http://127.0.0.1:\${globalThis.Deno.env.get("PORT")}\`;
const probes = [];
for (const route of ["/health", "/client-config", "/"]) {
  const res = await fetch(base + route);
  probes.push({ route, status: res.status, body: (await res.text()).slice(0, 400) });
}
process.stdout.write(PROBE_START + JSON.stringify(probes) + PROBE_END);
process.exit(0);
`,
        );

        const { stdout } = await run("deno", ["run", "-A", driver], {
          cwd: deployed,
          env: { ...process.env, PORT: "8791", ASSEMBLYAI_API_KEY: "scenario-test-key" },
        });
        // Fenced rather than parsed off raw stdout: booting the server writes a
        // startup banner there, so `JSON.parse(stdout)` fails on it. The old
        // assertion was `toContain("200")`, which tolerated the banner by
        // checking almost nothing — the fence is what buys a real parse.
        const fenced = new RegExp(`${PROBE_START}(.*)${PROBE_END}`, "s").exec(stdout);
        if (fenced?.[1] === undefined) {
          throw new Error(`driver printed no probe block:\n${stdout}`);
        }
        const probes = new Map(
          (JSON.parse(fenced[1]) as { route: string; status: number; body: string }[]).map((p) => [
            p.route,
            p,
          ]),
        );

        // The worker travelled and was LOADED: the name can only come from
        // `.aai/worker.mjs`, which no bundler could have inlined.
        expect(probes.get("/health")?.status).toBe(200);
        expect(probes.get("/health")?.body).toContain("Deno Probe");

        // What a browser reads before it dials.
        expect(probes.get("/client-config")?.status).toBe(200);
        expect(probes.get("/client-config")?.body).toContain("Deno Probe");

        // The client is SERVED, not merely copied. `_deno-output.test.ts`
        // asserts the directory was written; only this can say the server
        // resolves it with no `node_modules` to answer `defaultClientDir()`.
        expect(probes.get("/")?.status).toBe(200);
        expect(probes.get("/")?.body).toContain("<html");
      }),
    );
  }, 120_000);
});
