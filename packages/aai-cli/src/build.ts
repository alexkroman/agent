// Copyright 2025 the AAI authors. MIT license.
/**
 * `aai build` — bundle the agent without deploying, behind the same gates
 * deploy runs (tests, then typecheck), so the command previews the deploy
 * artifact and its failures alike.
 *
 * It also LEAVES that artifact on disk, at {@link WORKER_ARTIFACT_REL}, which is
 * what makes self-hosting work: `aai start` loads the built worker rather than
 * `agent.ts`, because a tool is discovered by the bundler enumerating `tools/`
 * and no un-bundled loader can see that directory. See `start.ts` and
 * "Self-hosting is the scaffold's default" in `packages/aai-cli/CLAUDE.md`.
 *
 * `--target` decides what else it emits — see `_build-target.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { agentConfigWarnings } from "@alexkroman1/aai/manifest";
import { WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import {
  type BuildTarget,
  DENO_OUTPUT_DIR,
  MODAL_APP_FILE,
  MODAL_OUTPUT_DIR,
  resolveBuildTarget,
  VERCEL_OUTPUT_DIR,
} from "./_build-target.ts";
import { buildAgentBundle, evalWorkerBundle } from "./_bundler.ts";
import { emitDenoOutput } from "./_deno-output.ts";
import { emitModalOutput } from "./_modal-output.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";
import { log, notify } from "./_ui.ts";
import { emitVercelOutput } from "./_vercel-output.ts";
import { determinismWarnings, scanWorkflowDeterminism } from "./_workflow-determinism.ts";
import { classifyVitestError, runVitest, TEST_FILES } from "./test.ts";

/**
 * Where the built worker lands, relative to the project root — under `.aai/`,
 * beside the built client, so one gitignore rule covers every build output.
 *
 * `start.ts` imports this constant rather than restating the path, which it
 * could not do while the loader was a `.mjs` file in the user's project. The
 * pair is covered end-to-end by the `npm start` leg of `e2e.test.ts` — the only
 * tier that runs both halves as a user does.
 */
export { WORKER_ARTIFACT_REL } from "./_artifacts.ts";

type BuildData = {
  name: string;
  workerBytes: number;
  /** Absolute path of the worker written — what `npm start` boots. */
  worker: string;
  /**
   * WHERE the prompt this bundle carries came from — see
   * {@link systemPromptSource}.
   */
  systemPrompt: string;
  /** Which deployment shape this build emitted — see `_build-target.ts`. */
  target: BuildTarget;
};

/**
 * The prose slot, named by convention. Mirrors `worker-bundler.ts`'s constant of
 * the same name — the two cannot share one without an import cycle
 * (`build.ts` → `_bundler.ts` → `worker-bundler.ts`), so `_build.test.ts` pins
 * the pair end to end instead: a build whose prompt really came from the file
 * has to report the file.
 */
const SYSTEM_PROMPT_FILE = "system-prompt.md";

/** What {@link systemPromptSource} reports when nothing declared a prompt. */
const FRAMEWORK_DEFAULT_PROMPT_SOURCE = "the framework default (DEFAULT_SYSTEM_PROMPT)";

/**
 * Which of the three possible authors of this agent's system prompt actually
 * wrote the one in the bundle.
 *
 * `aai build` reported `name` and `workerBytes` and nothing about the prompt,
 * and the prompt is the one field that can change COMPLETELY without any
 * config changing: deleting `system-prompt.md` swaps in
 * `DEFAULT_SYSTEM_PROMPT` — a total personality change — with exit 0 and no
 * line anywhere. `withSystemPrompt` refuses the case where a file exists and
 * nothing reads it; it cannot refuse a file that is simply GONE, because that
 * is what an agent with no file legitimately looks like. So this is a report
 * rather than a check.
 *
 * Decided by comparing VALUES against the built agent's resolved prompt, which
 * is the same method `withSystemPrompt` uses and for the same reason — the
 * alternative asks the bundler's module graph a question, and the author may
 * have imported the file and composed it, which is neither "the file" nor
 * "agent.ts" alone.
 */
async function systemPromptSource(cwd: string, resolved: string): Promise<string> {
  if (resolved === DEFAULT_SYSTEM_PROMPT) return FRAMEWORK_DEFAULT_PROMPT_SOURCE;
  const file = await fs
    .readFile(path.join(cwd, SYSTEM_PROMPT_FILE), "utf-8")
    .catch(() => undefined);
  const trimmed = file?.trim();
  if (trimmed === undefined || trimmed === "" || !resolved.includes(trimmed)) return "agent.ts";
  return resolved.trim() === trimmed
    ? SYSTEM_PROMPT_FILE
    : `agent.ts (composing ${SYSTEM_PROMPT_FILE})`;
}

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
  /**
   * Which deployment shape to emit beside the worker. Absent, it is detected
   * from the host's own build environment — see `resolveBuildTarget`.
   */
  target?: string | undefined;
}): Promise<CommandResult<BuildData>> {
  const { cwd } = opts;
  // Resolved BEFORE the suite and the typecheck, so an unknown `--target` fails
  // in a second rather than after a full test run.
  const target = resolveBuildTarget(opts.target);
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
  await assertTypechecks(cwd, { skip: opts.skipTypecheck });

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

  await emitTargetFiles(cwd, target, { name: agentDef.name });

  // Reported in BOTH modes, deliberately: `log` is silenced under --json, and a
  // field on the result is invisible on a TTY, so the swap this exists to
  // surface would stay invisible in whichever mode the reader happened to use.
  const systemPrompt = await systemPromptSource(cwd, agentDef.systemPrompt);
  log.info(`System prompt: ${systemPrompt}`);
  log.success("Build complete");

  return ok({
    name: agentDef.name,
    workerBytes: bundle.worker.length,
    worker,
    systemPrompt,
    target,
  });
}

/**
 * Write what a target needs, if it needs anything.
 *
 * `node` writes nothing: a long-lived process runs `aai start`, which needs no
 * generated file. `vercel` writes a complete prebuilt deployment under
 * `.vercel/output/` — see `_vercel-output.ts`, and `VERCEL_OUTPUT_DIR` in
 * `_build-target.ts` for why that directory and not an `api/` entry beside a
 * generated `vercel.json`. `deno` and `modal` write a self-contained directory
 * each — `_target-output.ts` for the half they share.
 *
 * The agent's `name` reaches only `modal`, which needs it for the app name a
 * deployment is served under. It is threaded through rather than re-read
 * because `executeBuild` has already evaluated the bundle to report it.
 */
async function emitTargetFiles(
  cwd: string,
  target: BuildTarget,
  agent: { name: string },
): Promise<void> {
  // A SWITCH rather than an if-chain, so `BuildTarget` gaining a member is a
  // compile error here rather than a build that silently emits nothing for it
  // — which presents as a deploy 404 rather than as anything about the build.
  switch (target) {
    case "node":
      return;
    case "vercel":
      await emitVercelOutput(cwd);
      log.info(`Target ${target}: wrote ${VERCEL_OUTPUT_DIR}`);
      return;
    case "deno":
      await emitDenoOutput(cwd);
      log.info(`Target ${target}: wrote ${DENO_OUTPUT_DIR} — deploy it with \`deno deploy\``);
      return;
    case "modal":
      await emitModalOutput(cwd, { name: agent.name });
      // The command NAMES the app file, because `modal deploy` takes a path to
      // a Python module and there is nothing in the directory to infer it from
      // — unlike `deno deploy`, which is pointed at the directory itself.
      log.info(
        `Target ${target}: wrote ${MODAL_OUTPUT_DIR} — deploy it with ` +
          `\`modal deploy ${path.join(MODAL_OUTPUT_DIR, MODAL_APP_FILE)}\``,
      );
      return;
    default: {
      // Biome requires a default; this one is what makes the switch EXHAUSTIVE.
      // A new `BuildTarget` member fails to assign to `never` here, so adding
      // one without an emit is a compile error rather than a target that builds
      // and deploys nothing.
      const unhandled: never = target;
      throw new Error(`Unhandled build target ${String(unhandled)}`);
    }
  }
}
