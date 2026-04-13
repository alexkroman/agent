// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@alexkroman1/aai";
import * as p from "@clack/prompts";
import { colorize } from "consola/utils";
import { DEFAULT_DEV_SERVER, getMonorepoRoot, isDevMode } from "./_agent.ts";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { fileExists, resolveCwd } from "./_utils.ts";

type InitData = {
  dir: string;
  template: string;
  deployed: boolean;
  slug?: string;
  url?: string;
};

const execFileAsync = promisify(execFile);

const DEFAULT_PROJECT_NAME = "my-voice-agent";

/** Prompt for project name or return default when --yes is set. */
async function promptProjectName(yes?: boolean): Promise<string> {
  if (yes) return DEFAULT_PROJECT_NAME;
  const result = await p.text({
    message: "What is your project named?",
    placeholder: DEFAULT_PROJECT_NAME,
    defaultValue: DEFAULT_PROJECT_NAME,
  });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }
  return result || DEFAULT_PROJECT_NAME;
}

/** Enable corepack so pnpm is available (scaffold declares packageManager: pnpm). */
async function ensurePnpm(): Promise<void> {
  try {
    await execFileAsync("corepack", ["enable"]);
  } catch {
    // corepack not available or already enabled — pnpm install will fail
    // with a clear error if pnpm isn't available
  }
}

/** Check if the project has any dependencies to install. */
async function hasDeps(cwd: string): Promise<boolean> {
  if (await fileExists(path.join(cwd, "node_modules"))) return false;
  let pkgJson: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"));
  } catch {
    pkgJson = {};
  }
  const deps = Object.keys(pkgJson.dependencies ?? {});
  const devDeps = Object.keys(pkgJson.devDependencies ?? {});
  return deps.length > 0 || devDeps.length > 0;
}

/** Check whether the safe-chain binary is on PATH. */
async function hasSafeChain(): Promise<boolean> {
  try {
    await execFileAsync("safe-chain", ["--version"]);
    return true;
  } catch {
    return false;
  }
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
  await execFileAsync(cmd, [...args, ...pnpmArgs], { cwd });
}

/** Install deps with pnpm (scaffold declares packageManager: pnpm). */
async function installDeps(cwd: string, silent?: boolean): Promise<void> {
  if (!(await hasDeps(cwd))) return;
  await ensurePnpm();

  if (silent) {
    try {
      await runPnpmInstall(cwd);
    } catch (err: unknown) {
      log.warn(`pnpm install failed: ${errorMessage(err)}`);
      log.warn("Run `corepack enable && pnpm install` manually in the project directory.");
    }
    return;
  }

  const s = p.spinner();
  s.start("Installing dependencies with pnpm");
  try {
    await runPnpmInstall(cwd);
    s.stop("Dependencies installed");
  } catch (err: unknown) {
    s.stop("Dependency install failed");
    log.warn(`pnpm install failed: ${errorMessage(err)}`);
    log.warn("Run `corepack enable && pnpm install` manually in the project directory.");
  }
}

/** Resolve target directory relative to the user's current directory. */
function resolveTargetDir(dir: string): string {
  return path.resolve(resolveCwd(), dir);
}

/** Resolve the deploy server — in dev mode, default to localhost. */
function resolveDeployServer(
  explicit: string | undefined,
  monorepoRoot: string | null,
): string | undefined {
  return explicit ?? (monorepoRoot ? DEFAULT_DEV_SERVER : undefined);
}

/** Run deploy after init and return deploy metadata if successful. */
async function tryDeploy(
  cwd: string,
  server: string | undefined,
  monorepoRoot: string | null,
): Promise<{ slug: string; url: string } | null> {
  const resolvedServer = resolveDeployServer(server, monorepoRoot);
  const { executeDeploy } = await import("./deploy.ts");
  const result = await executeDeploy({
    cwd,
    ...(resolvedServer ? { server: resolvedServer } : {}),
  });
  return result.ok ? { slug: result.data.slug, url: result.data.url } : null;
}

/** Scaffold the project, optionally showing a spinner. */
async function scaffoldProject(
  dir: string,
  cwd: string,
  template: string,
  silent?: boolean,
): Promise<void> {
  const { runInit } = await import("./_init.ts");
  if (silent) {
    await runInit({ targetDir: cwd, template });
    return;
  }
  const s = p.spinner();
  s.start(`Creating ${dir}`);
  await runInit({ targetDir: cwd, template });
  s.stop("Project created");
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
    skipApi?: boolean | undefined;
    skipDeploy?: boolean | undefined;
    server?: string | undefined;
  },
  extra?: { quiet?: boolean | undefined; silent?: boolean | undefined },
): Promise<CommandResult<InitData>> {
  const suppressUi = extra?.quiet ?? extra?.silent;
  if (!suppressUi) {
    p.intro(colorize("cyanBright", "Create a new voice agent"));
  }

  const dir = opts.dir ?? (await promptProjectName(opts.yes));
  const monorepoRoot = getMonorepoRoot();
  const cwd = resolveTargetDir(dir);

  if (!opts.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error(
      `agent.ts already exists in this directory. Use ${colorize("cyanBright", "--force")} to overwrite.`,
    );
  }

  const template = opts.template ?? "simple";

  await scaffoldProject(dir, cwd, template, suppressUi);
  await installDeps(cwd, suppressUi);

  let deployed = false;
  let slug: string | undefined;
  let url: string | undefined;

  if (!(opts.skipDeploy || extra?.quiet)) {
    const deployInfo = await tryDeploy(cwd, opts.server, monorepoRoot);
    if (deployInfo) {
      deployed = true;
      slug = deployInfo.slug;
      url = deployInfo.url;
    }
  }

  if (!suppressUi) {
    printPostInitInfo(cwd, monorepoRoot);
  }

  const data: InitData = { dir: cwd, template, deployed };
  if (slug) data.slug = slug;
  if (url) data.url = url;
  return ok(data);
}

export async function runInitCommand(
  opts: Parameters<typeof executeInit>[0],
  extra?: Parameters<typeof executeInit>[1],
): Promise<string> {
  const result = await executeInit(opts, extra);
  if (!result.ok) throw new Error(result.error);
  return result.data.dir;
}
