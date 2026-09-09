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
import type { AgentDef } from "@alexkroman1/aai";
import { DEFAULT_SYSTEM_PROMPT } from "@alexkroman1/aai";
import { agentConfigWarnings } from "@alexkroman1/aai/manifest";
import { WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import {
  type BuildTarget,
  type DeployStep,
  resolveBuildTarget,
  resolveDeploySteps,
  SECRET_NAME_PLACEHOLDER,
  TARGET_OUTPUTS,
} from "./_build-target.ts";
import { buildAgentBundle, evalWorkerBundle, evalWorkerConfig } from "./_bundler.ts";
import { emitDenoOutput } from "./_deno-output.ts";
import { emitModalOutput } from "./_modal-output.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
// TYPE-only, so this costs nothing at startup: `_preflight.ts` pulls in the
// SDK's runtime barrel, which is why every value it exports is reached through
// a lazy `await import` here and in `deploy.ts`.
import type { PreflightConfig } from "./_preflight.ts";
import { DEPLOY_ENV_DECLARATION_FILE, declaredEnvNames } from "./_server-common.ts";
import { assertTypechecks } from "./_typecheck-gate.ts";
import { log, notify } from "./_ui.ts";
import { emitVercelOutput } from "./_vercel-output.ts";
import { classifyVitestError, runVitest } from "./_vitest-runner.ts";
import { determinismWarnings, scanWorkflowDeterminism } from "./_workflow-determinism.ts";
import { TEST_FILES } from "./test.ts";

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
  /**
   * Where the target's output landed, relative to the project root, and the
   * command that ships it — `undefined` for a target that has neither.
   *
   * On the RESULT and not only in a log line, for the reason `systemPrompt`
   * above is: `log` is silenced under `--json`, so a CI job that builds and
   * then deploys could read neither the directory it should upload nor the
   * command that uploads it, and had to restate both from this file.
   *
   * `deploy` is the RESOLVED sequence — see {@link resolveDeploySteps} — so a
   * CI job can execute it in order rather than re-encoding each host's
   * prerequisites. Empty for a target that deploys nowhere.
   */
  outputDir: string | undefined;
  deploy: DeployStep[];
  /**
   * Variables the deployment DECLARES and this build's host had no value for —
   * see {@link missingDeployEnv}. Empty for a target that deploys nowhere.
   *
   * On the result as well as in a warning, for the reason `outputDir` above is:
   * `log` is silenced under `--json`, and this is the field a CI job would gate
   * its own deploy step on.
   */
  missingEnv: string[];
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
 * Decided by comparing VALUES against the built agent's declared prompt, which
 * is the same method `withSystemPrompt` uses and for the same reason — the
 * alternative asks the bundler's module graph a question, and the author may
 * have imported the file and composed it, which is neither "the file" nor
 * "agent.ts" alone.
 */
async function systemPromptSource(
  cwd: string,
  declared: AgentDef["systemPrompt"],
): Promise<string> {
  // A RESOLVER has no source to name and no file it could be composing: it is
  // computed per request from the session, and there is no session here to ask
  // it with. Reported as itself rather than guessed at — this line exists to
  // surface a swap, and "agent.ts" would read as a static prompt that happens
  // to live there.
  if (typeof declared !== "string") return "agent.ts (a per-request resolver)";
  if (declared === DEFAULT_SYSTEM_PROMPT) return FRAMEWORK_DEFAULT_PROMPT_SOURCE;
  const file = await fs
    .readFile(path.join(cwd, SYSTEM_PROMPT_FILE), "utf-8")
    .catch(() => undefined);
  const trimmed = file?.trim();
  if (trimmed === undefined || trimmed === "" || !declared.includes(trimmed)) return "agent.ts";
  return declared.trim() === trimmed
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
      // green this whole change is about. Measured on the retail-orders-agent template:
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
  const output = TARGET_OUTPUTS[target];
  // Same posture as the two warning classes above, one layer out: a declared
  // variable with no value on the host is legal, builds green, and fails at the
  // first session as an opaque provider auth error. See `missingDeployEnv`.
  //
  // `__aaiConfig`, not the `agentDef` above, and the difference is the whole
  // point of reading it: the export is `toAgentConfig(def)`, so an author
  // shorthand (`llm: "gpt-5"`) has been normalized into a descriptor whose
  // credential is derivable. `descriptorKind` reads a raw string as no kind at
  // all, so deriving from the def would silently omit that provider's key —
  // `_preflight.ts` carries the argument, and `aai deploy` reads the same
  // export for the same reason.
  //
  // It costs a SECOND evaluation of the user's bundle, so it is skipped for a
  // target that deploys nowhere — which is every ordinary local build, `node`
  // being the default and `missingDeployEnv` returning nothing for it anyway.
  const deployConfig = output.dir === undefined ? undefined : await evalWorkerConfig(bundle.worker);
  const missingEnv = await missingDeployEnv(
    cwd,
    target,
    process.env,
    // `evalWorkerConfig` answers `unknown` — the export is the USER's SDK's —
    // and nothing at all for a bundle old enough not to emit it. Truthiness is
    // the narrowing `aai deploy` applies to the same value, and a falsy one
    // means "nothing to derive", never an error.
    deployConfig || undefined,
  );
  for (const warning of missingEnvWarnings(missingEnv, target, agentDef.name)) {
    notify("warn", warning);
  }
  if (output.dir !== undefined) log.info(`Target ${target}: wrote ${output.dir}`);
  // Nitro prints the same line after every build, and for the same reason: the
  // artifact is useless to somebody who does not know the command that ships
  // it, and `--target vercel` used to print only the directory.
  const deploy = resolveDeploySteps(target, { agentName: agentDef.name, missingEnv });
  if (deploy.length > 0) {
    log.info("Deploy it with:");
    // The `build` step is dropped HERE and kept on the result: this reader just
    // ran one, so printing it as step 1 is noise, while a `--json` consumer may
    // be scripting a checkout where it is the step that matters. Numbered over
    // what remains, so the list reads as the sequence to type.
    const printed = deploy.filter((step) => step.when !== "build");
    printed.forEach((step, index) => {
      const note = step.when === "once" ? "   (first deploy only)" : "";
      log.info(`  ${index + 1}. ${step.run}${note}`);
    });
    // The footgun the `build` step exists for, stated once rather than as a
    // step the reader would read as already done. `deno deploy` and
    // `modal deploy` upload the directory as it stands.
    log.info(`Re-run \`aai build --target ${target}\` before every deploy.`);
  }

  // Reported in BOTH modes, deliberately: `log` is silenced under --json, and a
  // field on the result is invisible on a TTY, so the swap this exists to
  // surface would stay invisible in whichever mode the reader happened to use.
  // Passed UNRESOLVED, because `systemPrompt` may be a RESOLVER: there is no
  // session at build time to call one with, so `systemPromptSource` reports it
  // as a resolver rather than inventing a value — the same thing
  // `withSystemPrompt` and `toAgentConfig` do with one.
  const systemPrompt = await systemPromptSource(cwd, agentDef.systemPrompt);
  log.info(`System prompt: ${systemPrompt}`);
  log.success("Build complete");

  return ok({
    name: agentDef.name,
    workerBytes: bundle.worker.length,
    worker,
    systemPrompt,
    target,
    outputDir: output.dir,
    deploy,
    missingEnv,
  });
}

/**
 * Write what a target needs, if it needs anything.
 *
 * `node` writes nothing: a long-lived process runs `aai start`, which needs no
 * generated file. `vercel` writes a complete prebuilt deployment under
 * `.vercel/output/` — see `_vercel-output.ts`, and `VERCEL_OUTPUT_DIR` in
 * `_vercel-target.ts` for why that directory and not an `api/` entry beside a
 * generated `vercel.json`. `deno` and `modal` write a self-contained directory
 * each — `_target-output.ts` for the half they share.
 *
 * WHERE each lands and how it is deployed is `TARGET_OUTPUTS`, not this
 * function, and the caller reports it. Those strings were a `log.info` per
 * `case` and drifted the way a per-arm string does: `vercel` named its
 * directory and no deploy command at all.
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
      return;
    case "deno":
      await emitDenoOutput(cwd);
      return;
    case "modal":
      await emitModalOutput(cwd, { name: agent.name });
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

/**
 * Which variables the DEPLOYMENT declares that this build's host has no value
 * for — the check behind the warning `aai build` prints for a host target.
 *
 * ## Where the DECLARATIONS come from
 *
 * Two sources, and for a long time only the first: `.env.example`, the one
 * dotenv file that ships, plus — when the caller has the built bundle's
 * normalized config — {@link requiredEnvNames}, i.e. the provider credentials
 * the stt/llm/tts/s2s descriptors imply and the agent's own `requiredEnv`.
 *
 * The example file alone was the wrong half of a pair. `anywhere.md` told
 * authors to "list what your tools read in `requiredEnv`" and promised the
 * build would warn by name about anything the deployment was missing, which was
 * true of the MANAGED path (`_preflight.ts`, which has always derived both) and
 * false here — so an agent declaring `requiredEnv: ["ORDERS_API_KEY"]` and no
 * matching example entry got neither the warning nor the `env add` step the
 * `perSecret` sequence expands from this same list. Both paths now read one
 * derivation.
 *
 * `.env.example` stays a source rather than becoming redundant: it is where a
 * variable that nothing static can see gets declared — one a tool reads
 * straight off `process.env`, or a host setting like `PORT` — and it is what a
 * user editing a deployment's configuration actually reads.
 *
 * ## Why the host environment and not `resolveServerEnv`
 *
 * The obvious implementation resolves {@link DEPLOY_ENV_FILES} the way the
 * deployment will and reports what came back empty. It is wrong here, and
 * wrong in exactly the case worth catching: `.env` is uploaded into a host's
 * BUILD workspace (Vercel filters uploads by `.vercelignore`, never by
 * `.gitignore`'s contents) and is deliberately NOT copied into the deployment
 * artifact — see `RUNTIME_FILES` in `_vercel-output.ts`, where shipping it was
 * a credential leak. So a developer's own `.env` sitting beside the build would
 * satisfy a resolver and satisfy nothing at runtime, silencing the warning for
 * the one deployment that needs it.
 *
 * Values therefore come from `env` alone, and declarations from
 * {@link DEPLOY_ENV_DECLARATION_FILE} alone — the single file that ships.
 *
 * ## What it can and cannot see
 *
 * On a host-run build this is precise: the build container's environment IS the
 * project's configured variables, so a name missing here is a name missing at
 * runtime. That is the zero-config path `TARGET_ENV_MARKERS` describes and the
 * failure this was written for — a Vercel deployment whose `ASSEMBLYAI_API_KEY`
 * was never set, which built green and died at its first session.
 *
 * Two inaccuracies follow from a build being unable to interrogate its own
 * host, and both are why this WARNS rather than gates. A variable a host
 * exposes only at runtime (Vercel's sensitive variables) is reported though it
 * will resolve. And a build run locally reads the developer's shell, which says
 * nothing about what the host has — so an exported value hides a name the
 * platform is still missing.
 *
 * @param env - Where values are read from. Defaults to the build's own
 *   environment; a parameter so a spec need not mutate `process.env`.
 * @param config - The built bundle's `__aaiConfig`, when the caller has it.
 *   Omitted, only `.env.example` is read — which is what a spec asserting the
 *   file-declaration half wants, and what an older bundle carrying no such
 *   export leaves the caller with.
 */
export async function missingDeployEnv(
  cwd: string,
  target: BuildTarget,
  env: Record<string, string | undefined> = process.env,
  config?: PreflightConfig,
): Promise<string[]> {
  // A target with no output directory deploys nowhere, and `node` is the only
  // one: the deployment is a process someone starts, which reads `.env` at boot
  // and gets a provider credential from the shell through
  // `withHostCredentialFallback`. A blank there is a developer mid-setup, so
  // warning would fire on every ordinary local build and teach nothing.
  if (TARGET_OUTPUTS[target].dir === undefined) return [];
  // Lazily, and only on a path that already returned above for the default
  // target: `_preflight.ts` pulls in the SDK's runtime barrel for
  // `requiredProviderEnvVars` (~320ms, ~35MB), which `aai deploy` deliberately
  // keeps off its startup path for the same reason.
  const derived = config ? (await import("./_preflight.ts")).requiredEnvNames(config) : [];
  const declared = await declaredEnvNames(cwd, [DEPLOY_ENV_DECLARATION_FILE]);
  // An empty value counts as missing for the reason `resolveServerEnv` drops
  // it: `BRAVE_API_KEY=` is how the declaration says "you need to set this",
  // and a provider handed `""` authenticates with it instead of reporting the
  // credential as absent.
  return [...new Set([...declared, ...derived])].filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
}

/**
 * One warning sentence per variable {@link missingDeployEnv} reported, naming
 * the command that sets it where the target knows one.
 *
 * A sentence each rather than one combined line, matching `agentConfigWarnings`
 * and `determinismWarnings`: each is independently actionable, and the command
 * differs per name.
 */
export function missingEnvWarnings(
  missing: readonly string[],
  target: BuildTarget,
  agentName: string,
): string[] {
  // Read off the RESOLVED sequence rather than off `TARGET_OUTPUTS` directly,
  // so this warning and the printed steps cannot name two different commands —
  // Modal's secret name is derived from the agent's, and reading the raw record
  // here printed a literal `<secret>` beside a sequence showing the real one.
  // `missingEnv: []` because the placeholder form is what wants substituting,
  // once per name below.
  const secret = resolveDeploySteps(target, { agentName, missingEnv: [] }).find(
    (step) => step.when === "perSecret",
  )?.run;
  return missing.map((name) => {
    const fix =
      secret === undefined
        ? `Set it in the ${target} environment`
        : `Set it with \`${secret.replaceAll(SECRET_NAME_PLACEHOLDER, name)}\``;
    // "deploy again" because a host that injects variables at invocation still
    // captured the old set for THIS deployment — setting the value without a
    // redeploy leaves the same dead build serving.
    return `${name} is declared in ${DEPLOY_ENV_DECLARATION_FILE} but has no value in this build's environment, so the deployed agent will see none. ${fix}, then deploy again.`;
  });
}
