// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { colorize } from "consola/utils";
import { DEFAULT_DEV_SERVER, getMonorepoRoot, isDevMode } from "./_agent.ts";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { fileExists, resolveCwd } from "./_utils.ts";

// pnpm writes failures to stdout (not stderr) and execFile's err.message is just
// "Command failed: ...", so glue both streams onto the message for the user.
function formatInstallError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as { stderr?: string; stdout?: string };
  return [err.message, e.stderr?.trim(), e.stdout?.trim()].filter(Boolean).join("\n");
}

type InitData = {
  dir: string;
  template: string;
  deployed: boolean;
  slug?: string;
  url?: string;
};

const execFileAsync = promisify(execFile);

const DEFAULT_PROJECT_NAME = "my-voice-agent";

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

async function ensurePnpm(): Promise<void> {
  // No-op if corepack is missing or already enabled — `pnpm install` fails loudly later.
  await execFileAsync("corepack", ["enable"]).catch(() => {
    /* corepack missing or already enabled */
  });
}

async function hasDeps(cwd: string): Promise<boolean> {
  if (await fileExists(path.join(cwd, "node_modules"))) return false;
  let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkgJson = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf-8"));
  } catch {
    return false;
  }
  return (
    Object.keys(pkgJson.dependencies ?? {}).length > 0 ||
    Object.keys(pkgJson.devDependencies ?? {}).length > 0
  );
}

async function hasSafeChain(): Promise<boolean> {
  try {
    await execFileAsync("safe-chain", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePnpmCommand(
  checkSafeChain: () => Promise<boolean> = hasSafeChain,
): Promise<{ cmd: string; args: string[] }> {
  if (await checkSafeChain()) {
    return { cmd: "safe-chain", args: ["pnpm", "--safe-chain-skip-minimum-package-age"] };
  }
  return { cmd: "pnpm", args: [] };
}

async function runPnpmInstall(cwd: string): Promise<void> {
  const { cmd, args } = await resolvePnpmCommand();
  // Dev mode wants workspace resolution; in production --ignore-workspace
  // prevents pnpm from hoisting into a parent workspace.
  const pnpmArgs = isDevMode() ? ["install"] : ["install", "--ignore-workspace"];
  await execFileAsync(cmd, [...args, ...pnpmArgs], { cwd });
}

async function installDeps(cwd: string, silent?: boolean): Promise<boolean> {
  if (!(await hasDeps(cwd))) return true;
  await ensurePnpm();

  const spinner = silent ? null : p.spinner();
  spinner?.start("Installing dependencies with pnpm");
  try {
    await runPnpmInstall(cwd);
    spinner?.stop("Dependencies installed");
    return true;
  } catch (err) {
    spinner?.stop("Dependency install failed");
    log.warn(`pnpm install failed: ${formatInstallError(err)}`);
    log.warn("Run `corepack enable && pnpm install` manually in the project directory.");
    return false;
  }
}

async function tryDeploy(
  cwd: string,
  server: string | undefined,
  monorepoRoot: string | null,
): Promise<{ slug: string; url: string } | null> {
  const resolvedServer = server ?? (monorepoRoot ? DEFAULT_DEV_SERVER : undefined);
  const { executeDeploy } = await import("./deploy.ts");
  const result = await executeDeploy({
    cwd,
    ...(resolvedServer ? { server: resolvedServer } : {}),
  });
  return result.ok ? { slug: result.data.slug, url: result.data.url } : null;
}

async function scaffoldProject(
  dir: string,
  cwd: string,
  template: string,
  silent?: boolean,
): Promise<void> {
  const { runInit } = await import("./_init.ts");
  const spinner = silent ? null : p.spinner();
  spinner?.start(`Creating ${dir}`);
  await runInit({ targetDir: cwd, template });
  spinner?.stop("Project created");
}

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
  const cwd = path.resolve(resolveCwd(), dir);

  if (!opts.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error(
      `agent.ts already exists in this directory. Use ${colorize("cyanBright", "--force")} to overwrite.`,
    );
  }

  const template = opts.template ?? "simple";

  await scaffoldProject(dir, cwd, template, suppressUi);
  const installed = await installDeps(cwd, suppressUi);

  let deployed = false;
  let slug: string | undefined;
  let url: string | undefined;

  if (!installed) {
    log.warn("Skipping deploy because dependencies were not installed.");
  } else if (!(opts.skipDeploy || extra?.quiet)) {
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
