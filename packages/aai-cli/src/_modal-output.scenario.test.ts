// Copyright 2026 the AAI authors. MIT license.
/**
 * The Modal deployment, built for real — then RUN, and then PARSED.
 *
 * Scenario tier because all three arms are: a rolldown pass over the whole
 * runtime, a subprocess that boots the result, and a `python3` that reads the
 * generated `app.py`. A subprocess rather than an in-process import for the
 * same reason as the Vercel and Deno suites — booting an agent server starts a
 * runtime whose only shutdown door is `AgentServer.close()`, and the emitted
 * module exports nothing.
 *
 * The boot arm needs no gate at all, which is what makes it worth more than
 * the Deno equivalent it mirrors: Modal runs plain `node`, so the runtime under
 * test is the one already running the suite. What it proves is the claim the
 * whole target rests on — that a directory with NO `node_modules` boots — plus
 * the two things that are this entry's own: it reads `PORT` from
 * `process.env`, and it drains on SIGTERM.
 *
 * The `app.py` arms exist because nothing else in this repo reads that file.
 * `tsc` cannot see it, Biome does not lint it, and the next thing to evaluate
 * it is `modal deploy` on a user's machine — so a template edit that breaks
 * the Python is invisible to every other gate here.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import {
  MODAL_APP_FILE,
  MODAL_ENTRY_FILE,
  MODAL_ENTRY_SOURCE,
  MODAL_OUTPUT_DIR,
} from "./_build-target.ts";
import { emitModalOutput } from "./_modal-output.ts";
import { bundleTargetEntry } from "./_target-bundle.ts";
import { linkProjectNodeModules, silenced, withTempDir } from "./_test-utils.ts";

const run = promisify(execFile);

/**
 * A `python3` that can `import modal`, if there is one.
 *
 * `spawnSync` at module scope rather than an `await` in a test body, for the
 * reason `describeWithDeno` documents: a probe awaited inside a test can only
 * produce a pass or a fail, never a skip, so a gate has to be decided at
 * COLLECTION time to be a gate at all.
 */
const PYTHON = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const MODAL_LIB =
  PYTHON && spawnSync("python3", ["-c", "import modal"], { stdio: "ignore" }).status === 0;

const PYTHON_HOW_TO = "Install python3 (CI's ubuntu runners already carry one).";
const MODAL_HOW_TO = "Install the client into the python3 on PATH: `pip install modal`.";

// Biome's `noSkippedTests` flags the `describe.skip(…)` CALL form, so the gated
// suites reference it instead — exactly as the Deno suite does.
const skipSuite = describe.skip;

/**
 * A suite needing a real interpreter, whose skip ANNOUNCES itself.
 *
 * `AAI_REQUIRE_MODAL` turns the skip into a hard failure, so a broken setup
 * step cannot read as a green run. **CI does not set it today** — no job
 * installs the Modal client — so it is the local escape hatch, declared in
 * `check:scenario`'s `env` in `turbo.json` because strict env mode would
 * otherwise strip it and the enforcement would be silently inert.
 */
function describeWith(available: boolean, howTo: string, name: string, body: () => void): void {
  if (available) {
    describe(name, body);
    return;
  }
  if ((process.env.AAI_REQUIRE_MODAL ?? "") !== "") {
    throw new Error(`AAI_REQUIRE_MODAL is set but the tooling is missing.\n${howTo}`);
  }
  console.warn(`\n[skipped] ${name} not run.\n${howTo}\n`);
  skipSuite(name, body);
}

/** A built project: the worker the entry loads, and its env declaration. */
async function builtProject(dir: string): Promise<void> {
  await linkProjectNodeModules(dir);
  await fs.mkdir(path.join(dir, ".aai"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".aai", "worker.mjs"),
    `export default { name: "Modal Probe", systemPrompt: "hi", greeting: "hi", tools: {} };\n`,
  );
  await fs.writeFile(path.join(dir, ".env.example"), "ASSEMBLYAI_API_KEY=\n");
}

/**
 * The emitted directory, copied to a SIBLING of the project.
 *
 * A sibling and never a child, which is the whole validity of the boot arm:
 * module resolution walks UP, so a copy inside the project finds the project's
 * own `node_modules` and the "no node_modules" claim passes while being false.
 * The Deno suite A/B'd both ways and only the sibling reproduces a deployment.
 */
async function deployedCopy(dir: string): Promise<string> {
  const deployed = await fs.mkdtemp(path.join(os.tmpdir(), "aai_modal_deployed_"));
  await fs.cp(path.join(dir, MODAL_OUTPUT_DIR), deployed, { recursive: true });
  onTestFinished(async () => {
    await fs.rm(deployed, { recursive: true, force: true });
  });
  return deployed;
}

describe("the bundled Modal entry", () => {
  test("carries no build toolchain, and no native binding it could not bundle", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        const code = await bundleTargetEntry(dir, MODAL_ENTRY_SOURCE, "modal");

        // The reason this target bundles at all: the image installs nothing, so
        // an unbundled entry would need a lockfile, a package manager and the
        // whole dependency tree baked into a container layer.
        expect(code).not.toContain("@rolldown/binding");
        expect(code).toMatch(/await server\.listen\(/);
      }),
    );
  }, 120_000);
});

describe("the emitted Modal output, run under node", () => {
  test("boots from a directory with no node_modules, on the port app.py sets", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitModalOutput(dir, { name: "Modal Probe" });
        const deployed = await deployedCopy(dir);

        const driver = path.join(deployed, "driver.mjs");
        await fs.writeFile(
          driver,
          `await import("./${MODAL_ENTRY_FILE}");
const res = await fetch(\`http://127.0.0.1:\${process.env.PORT}/health\`);
process.stdout.write(\`\${res.status} \${await res.text()}\`);
process.exit(0);
`,
        );

        // PORT only — exactly what the image env gives the container, which is
        // what proves the entry reads it rather than falling back.
        const { stdout } = await run("node", [driver], {
          cwd: deployed,
          env: { ...process.env, PORT: "8793", ASSEMBLYAI_API_KEY: "scenario-test-key" },
        });
        expect(stdout).toContain("200");
        expect(stdout).toContain("Modal Probe");
      }),
    );
  }, 120_000);

  test("closes the server on SIGTERM instead of dropping the process", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitModalOutput(dir, { name: "Modal Probe" });
        const deployed = await deployedCopy(dir);

        // app.py forwards the container's stop signal and WAITS for this exit,
        // so a zero here is what makes that wait terminate — and what makes a
        // redeploy end live calls rather than cutting their sockets.
        const child = spawn("node", [path.join(deployed, MODAL_ENTRY_FILE)], {
          cwd: deployed,
          env: { ...process.env, PORT: "8794", ASSEMBLYAI_API_KEY: "scenario-test-key" },
          stdio: "ignore",
        });
        onTestFinished(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });

        // `vi.waitFor`, never a hand-rolled poll: a bare loop over `fetch` to
        // a closed port spins as fast as the connection is refused.
        await vi.waitFor(
          async () => {
            expect((await fetch("http://127.0.0.1:8794/health")).ok).toBe(true);
          },
          { timeout: 30_000, interval: 100 },
        );

        const exit = new Promise<number | null>((resolve) => {
          child.once("exit", (code) => resolve(code));
        });
        child.kill("SIGTERM");
        expect(await exit).toBe(0);
      }),
    );
  }, 120_000);
});

describeWith(PYTHON, PYTHON_HOW_TO, "the generated app.py, read by python3", () => {
  test("parses", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitModalOutput(dir, { name: "Modal Probe", bundle: () => Promise.resolve("//\n") });
        const app = path.join(dir, MODAL_OUTPUT_DIR, MODAL_APP_FILE);
        // A syntax error here is a file that reaches a user and fails on their
        // machine, with the build that produced it long since green.
        await expect(run("python3", ["-m", "py_compile", app])).resolves.toBeDefined();
      }),
    );
  }, 120_000);
});

describeWith(MODAL_LIB, MODAL_HOW_TO, "the generated app.py, loaded by the modal client", () => {
  test("every decorator argument it passes is one the installed client accepts", async () => {
    await withTempDir(
      silenced(async (dir) => {
        await builtProject(dir);
        await emitModalOutput(dir, { name: "Modal Probe", bundle: () => Promise.resolve("//\n") });
        const outputDir = path.join(dir, MODAL_OUTPUT_DIR);

        // Importing the module is what a deploy does first, and it is the only
        // check here that reads the REAL API: it evaluates `from_registry`,
        // `add_local_dir`, `@app.function`'s kwargs, `@modal.concurrent` and
        // `@modal.web_server`. A renamed or dropped parameter in any of them is
        // a TypeError at import — the failure a user would otherwise meet.
        // Lazy by design, so it needs no credentials and no network.
        const probe = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("app", ${JSON.stringify(path.join(outputDir, MODAL_APP_FILE))})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps({"app": mod.app.name, "port": mod.PORT, "entry": mod.ENTRY}))
`;
        const { stdout } = await run("python3", ["-c", probe], { cwd: outputDir });
        const loaded = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
          app: string;
          port: number;
          entry: string;
        };
        expect(loaded.app).toBe("modal-probe");
        expect(loaded.entry).toBe(MODAL_ENTRY_FILE);
        // The module's own view of the port, read back through Python rather
        // than matched as a string — the one number the proxy and the node
        // process have to agree on.
        expect(loaded.port).toBe(8000);
      }),
    );
  }, 120_000);
});
