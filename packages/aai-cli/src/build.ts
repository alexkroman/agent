// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai build` — bundle the agent without deploying, behind the same gates
 * deploy runs (tests, then typecheck), so the command previews the deploy
 * artifact and its failures alike.
 *
 * It also LEAVES that artifact on disk, at {@link WORKER_ARTIFACT_REL}, which is
 * what makes self-hosting work: `server.mjs` loads the built worker rather than
 * `agent.ts`, because a tool is discovered by the bundler enumerating `tools/`
 * and no un-bundled loader can see that directory. See the scaffold's own
 * `server.mjs` and "Self-hosting runs the built worker" in
 * `packages/aai-templates/CLAUDE.md`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { agentConfigWarnings } from "@alexkroman1/aai/manifest";
import { buildAgentBundle, evalWorkerBundle } from "./_bundler.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";
import { log, notify } from "./_ui.ts";
import { determinismWarnings, scanWorkflowDeterminism } from "./_workflow-determinism.ts";
import { classifyVitestError, runVitest, TEST_FILES } from "./test.ts";

/**
 * Where the built worker lands, relative to the project root — under `.aai/`,
 * beside the built client, so one gitignore rule covers every build output.
 *
 * `server.mjs` hardcodes this path: it is a plain `.mjs` file in a user's
 * project and may not import from the CLI (which a deployed project does not
 * install at all). The pair is covered end-to-end by the `npm start` leg of
 * `e2e.test.ts` — the only tier that runs both halves as a user does.
 */
export const WORKER_ARTIFACT_REL = path.join(".aai", "worker.mjs");

type BuildData = {
  name: string;
  workerBytes: number;
  /** Absolute path of the worker written — what `npm start` boots. */
  worker: string;
};

/**
 * Map a {@link runVitest} failure to a CliError — distinguishing a real test
 * failure (test_failed) from the runner not spawning (spawn_failed) instead
 * of a generic command_failed.
 */
function testGateError(err: unknown): CliError {
  const { code, message } = classifyVitestError(err);
  return new CliError(code, message, "Re-run with --skipTests to build without tests", {
    cause: err,
  });
}

export async function executeBuild(opts: {
  cwd: string;
  skipTests?: boolean | undefined;
  skipTypecheck?: boolean | undefined;
}): Promise<CommandResult<BuildData>> {
  const { cwd } = opts;
  if (!opts.skipTests) {
    try {
      // The WHOLE suite, not `agent.test.ts` alone. `aai test`'s narrowing is
      // a fast-inner-loop contract — one documented file, so a spec that is
      // slow or wants credentials is not dragged into every iteration. A build
      // is the opposite situation: it previews the deploy artifact, it is run
      // deliberately, and a gate that reads one file out of eight is the false
      // green this whole change is about. Measured on the retail template:
      // adding one tool broke `registry.test.ts` and `aai build` stayed green
      // through all of it. `--skipTests` remains the way to opt out.
      runVitest(cwd, { candidates: TEST_FILES, all: true });
    } catch (err: unknown) {
      throw testGateError(err);
    }
  }
  if (!opts.skipTypecheck) await assertTypechecks(cwd);

  // `aai build` previews the deploy artifact, so build it exactly like deploy.
  const bundle = await buildAgentBundle(cwd, { minify: true });
  // Evaluate locally to validate the agent export and report its name.
  // `aai deploy` imports its bundle too (for the credential preflight), so
  // both commands run the developer's own project code — see the note in
  // packages/aai-cli/src/CLAUDE.md.
  const agentDef = await evalWorkerBundle(bundle.worker);
  // Legal, and worth saying — today that is a voice outside the catalog, whose
  // whole failure mode is that nothing says anything until the agent is live
  // and silent. See `agentConfigWarnings`.
  for (const warning of agentConfigWarnings(agentDef)) notify("warn", warning);
  // Same posture, one directory over: a clock or a fetch at workflow BODY level
  // is legal code whose failure mode is a step executing twice on a replay, with
  // the run reporting `completed`. A warning rather than a gate — see
  // `_workflow-determinism.ts` on why a line scan may not stop a build.
  for (const warning of determinismWarnings(await scanWorkflowDeterminism(cwd))) {
    notify("warn", warning);
  }

  // Written AFTER the evaluation, which is the bundle's smoke test: a worker
  // whose top level throws must not be left on disk as the thing `npm start`
  // boots. The command fails either way, so nothing reads a stale artifact.
  const worker = path.join(cwd, WORKER_ARTIFACT_REL);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(worker, bundle.worker, "utf-8");

  log.success("Build complete");

  return ok({
    name: agentDef.name,
    workerBytes: bundle.worker.length,
    worker,
  });
}
