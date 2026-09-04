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
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
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
  /**
   * WHERE the prompt this bundle carries came from — see
   * {@link systemPromptSource}.
   */
  systemPrompt: string;
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
  });
}
