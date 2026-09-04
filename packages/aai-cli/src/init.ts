// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { styleText } from "node:util";
import { omitUndefined } from "@alexkroman1/aai/utils";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { getMonorepoRoot, isDevMode } from "./_agent.ts";
import { type CommandResult, ok } from "./_output.ts";
import { log, unwrapCancel } from "./_ui.ts";
import { AGENT_ENTRY, errorMessage, fileExists, readJson, resolveCwd } from "./_utils.ts";

type InitData = {
  dir: string;
  template: string;
  deployed: boolean;
  slug?: string;
  url?: string;
  /**
   * Diagnostics a human sees as `log.warn` lines: a failed `pnpm install`, a
   * failed publish, the publish skipped because of the former.
   *
   * They have to ride the result for the same reason `PushOutcome.warnings`
   * does — `log.warn` is silenced in JSON mode and JSON mode is AUTO-DETECTED
   * on a pipe, so a scripted `aai init` was told `{ ok: true, deployed: false }`
   * for a project whose dependencies never installed and could not tell that
   * apart from `--skipDeploy`.
   */
  warnings?: string[];
};

/**
 * Run `fn` behind a clack spinner, stopping it in EVERY outcome.
 *
 * The naked form (`s?.start(); await work(); s?.stop()`) leaks the spinner on a
 * failure: clack keeps its interval and its raw-mode stdin hook, so a throw
 * left a spinner ticking under the error message with the cursor hidden. The
 * `catch` label is what the terminal is left showing, so it names the step.
 */
async function withSpinner<T>(
  silent: boolean | undefined,
  labels: { start: string; done: string; failed: string },
  fn: () => Promise<T>,
): Promise<T> {
  const s = silent ? undefined : p.spinner();
  s?.start(labels.start);
  // Not named `ok` — that is the result constructor this module imports.
  let succeeded = false;
  try {
    const value = await fn();
    succeeded = true;
    return value;
  } finally {
    s?.stop(succeeded ? labels.done : labels.failed);
  }
}

const DEFAULT_PROJECT_NAME = "my-voice-agent";

/** Prompt for project name or return default when --yes is set. */
async function promptProjectName(yes?: boolean): Promise<string> {
  if (yes) return DEFAULT_PROJECT_NAME;
  const result = unwrapCancel(
    await p.text({
      message: "What is your project named?",
      placeholder: DEFAULT_PROJECT_NAME,
      defaultValue: DEFAULT_PROJECT_NAME,
    }),
    "Setup cancelled",
  );
  return result || DEFAULT_PROJECT_NAME;
}

/** Best-effort corepack enable so pnpm is available (scaffold declares packageManager: pnpm). */
async function ensurePnpm(): Promise<void> {
  // Failure is fine (already enabled, or — on Node >= 25, half the range the
  // scaffold's engines allow — corepack is not installed at all, since Node
  // stopped shipping it in its official distributions). This only ever helps
  // the Node 24 end of the range; `pnpm install` fails with a clear error
  // otherwise, and the warning below says how to get pnpm without corepack.
  await execa("corepack", ["enable"], { reject: false });
}

/** Check if the project has any dependencies to install. */
async function hasDeps(cwd: string): Promise<boolean> {
  if (await fileExists(path.join(cwd, "node_modules"))) return false;
  const pkgJson = ((await readJson(path.join(cwd, "package.json"))) ?? {}) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = Object.keys(pkgJson.dependencies ?? {});
  const devDeps = Object.keys(pkgJson.devDependencies ?? {});
  return deps.length > 0 || devDeps.length > 0;
}

/** Check whether the safe-chain binary is on PATH. */
async function hasSafeChain(): Promise<boolean> {
  const { failed } = await execa("safe-chain", ["--version"], { reject: false });
  return !failed;
}

/** Build the command + args for running pnpm, routing through safe-chain when available. */
export async function resolvePnpmCommand(
  checkSafeChain: () => Promise<boolean> = hasSafeChain,
): Promise<{ cmd: string; args: string[] }> {
  if (await checkSafeChain()) {
    return { cmd: "safe-chain", args: ["pnpm", "--safe-chain-skip-minimum-package-age"] };
  }
  return { cmd: "pnpm", args: [] };
}

/** Run pnpm install and warn on failure. */
async function runPnpmInstall(cwd: string): Promise<void> {
  const { cmd, args } = await resolvePnpmCommand();
  // In dev mode, allow workspace resolution so workspace deps link to local source.
  // In production, --ignore-workspace prevents pnpm from hoisting to a parent workspace.
  const pnpmArgs = isDevMode() ? ["install"] : ["install", "--ignore-workspace"];
  // execa errors already include stderr + stdout in their message, so the
  // user sees what actually went wrong (pnpm writes failures to stdout).
  await execa(cmd, [...args, ...pnpmArgs], { cwd });
}

/** Install deps with pnpm. Returns true on success (or no deps to install). */
async function installDeps(cwd: string, warn: Warn, silent?: boolean): Promise<boolean> {
  if (!(await hasDeps(cwd))) return true;
  await ensurePnpm();

  try {
    await withSpinner(
      silent,
      {
        start: "Installing dependencies with pnpm",
        done: "Dependencies installed",
        failed: "Dependency install failed",
      },
      () => runPnpmInstall(cwd),
    );
    return true;
  } catch (err: unknown) {
    warn(`pnpm install failed: ${errorMessage(err)}`);
    warn("Install pnpm (`npm install -g pnpm`), then run `pnpm install` in the project.");
    return false;
  }
}

/** Resolve target directory relative to the user's current directory. */
function resolveTargetDir(dir: string): string {
  return path.resolve(resolveCwd(), dir);
}

/**
 * Record a diagnostic: shown to a human AND kept for the result.
 *
 * One call site, two destinations — that pairing is the point. `log.warn`
 * alone is silenced in JSON mode, and a second hand-written `warnings.push`
 * beside each call is how the two drift.
 */
type Warn = (message: string) => void;

function collectWarnings(): { warn: Warn; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    warn: (message) => {
      warnings.push(message);
      log.warn(message);
    },
  };
}

/** Publish after init and return deploy metadata if successful. */
async function tryPublish(
  cwd: string,
  server: string | undefined,
  warn: Warn,
): Promise<{ slug: string; url: string; studioUrl: string } | null> {
  // Server defaulting (dev mode → localhost) is owned by resolveServerUrl
  // inside executePublish — pass the explicit flag through untouched.
  const { executePublish } = await import("./studio.ts");
  try {
    const result = await executePublish({ cwd, ...omitUndefined({ server }) });
    if (result.ok) {
      return { slug: result.data.slug, url: result.data.url, studioUrl: result.data.studioUrl };
    }
    warn(`Publish failed: ${result.error}`);
    return null;
  } catch (err) {
    // The project was scaffolded and installed — a publish failure (server
    // unreachable, bad key) must not fail the whole init.
    warn(`Publish failed: ${errorMessage(err)}`);
    warn("Your project was still created — run `aai publish` in it to retry.");
    return null;
  }
}

/** Scaffold the project, optionally showing a spinner. */
async function scaffoldProject(
  dir: string,
  cwd: string,
  template: string,
  silent?: boolean,
): Promise<void> {
  const { runInit } = await import("./_init.ts");
  await withSpinner(
    silent,
    { start: `Creating ${dir}`, done: "Project created", failed: `Could not create ${dir}` },
    () => runInit({ targetDir: cwd, template }),
  );
}

/** Print post-init instructions. */
function printPostInitInfo(cwd: string, monorepoRoot: string | null): void {
  log.success(`Created ${cwd}`);
  if (monorepoRoot) log.info("Dev mode: project linked to workspace packages");
  log.info(`Next: cd ${cwd} && aai dev`);
}

export async function executeInit(
  opts: {
    dir?: string | undefined;
    force?: boolean | undefined;
    template?: string | undefined;
    yes?: boolean | undefined;
    skipDeploy?: boolean | undefined;
    server?: string | undefined;
  },
  extra?: { silent?: boolean | undefined },
): Promise<CommandResult<InitData>> {
  const suppressUi = extra?.silent;
  if (!suppressUi) {
    p.intro(styleText("cyanBright", "Create a new voice agent"));
  }

  const dir = opts.dir ?? (await promptProjectName(opts.yes));
  const monorepoRoot = getMonorepoRoot();
  const cwd = resolveTargetDir(dir);

  if (!opts.force && (await fileExists(path.join(cwd, AGENT_ENTRY)))) {
    throw new Error(
      `${AGENT_ENTRY} already exists in this directory. Use ${styleText("cyanBright", "--force")} to overwrite.`,
    );
  }

  const template = opts.template ?? "simple";
  const { warn, warnings } = collectWarnings();

  await scaffoldProject(dir, cwd, template, suppressUi);
  const installed = await installDeps(cwd, warn, suppressUi);

  if (!installed) warn("Skipping publish because dependencies were not installed.");
  // One record rather than three locals kept in sync: `deployed: true` with no
  // slug was representable, and it would report a successful publish with no
  // URL to open.
  const published = installed && !opts.skipDeploy ? await tryPublish(cwd, opts.server, warn) : null;

  if (!suppressUi) {
    printPostInitInfo(cwd, monorepoRoot);
  }

  const data: InitData = { dir: cwd, template, deployed: published !== null };
  if (published) {
    data.slug = published.slug;
    data.url = published.url;
  }
  // Omitted when empty so a clean init's result stays exactly as before.
  if (warnings.length > 0) data.warnings = warnings;
  return ok(data);
}
