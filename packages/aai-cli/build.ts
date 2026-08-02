// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai build` — bundle the agent without deploying, behind the same gates
 * deploy runs (tests, then typecheck), so the command previews the deploy
 * artifact and its failures alike.
 */

import { buildAgentBundle, evalWorkerBundle } from "./_bundler.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";
import { log } from "./_ui.ts";
import { classifyVitestError, runVitest } from "./test.ts";

type BuildData = {
  name: string;
  workerBytes: number;
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
      runVitest(cwd);
    } catch (err: unknown) {
      throw testGateError(err);
    }
  }
  if (!opts.skipTypecheck) await assertTypechecks(cwd);

  // `aai build` previews the deploy artifact, so build it exactly like deploy.
  const bundle = await buildAgentBundle(cwd, { minify: true });
  // Evaluate locally to validate the agent export and report its name —
  // `aai build` runs the developer's own project code, unlike deploy, which
  // leaves evaluation to the server's guest sandbox.
  const agentDef = await evalWorkerBundle(bundle.worker);
  log.success("Build complete");

  return ok({
    name: agentDef.name,
    workerBytes: bundle.worker.length,
  });
}
