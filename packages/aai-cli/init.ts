// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@alexkroman1/aai/utils";
import * as p from "@clack/prompts";
import { colorize } from "consola/utils";
import { DEFAULT_DEV_SERVER, getMonorepoRoot, isDevMode } from "./_agent.ts";
import { ensureApiKeyInEnv } from "./_config.ts";
import { type CommandResult, ok } from "./_output.ts";
import { listTemplates } from "./_templates.ts";
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
const DEFAULT_TEMPLATE = "simple";

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

/** Prompt for template selection or return default when --yes is set. */
async function promptTemplate(yes?: boolean): Promise<string> {
  if (yes) return DEFAULT_TEMPLATE;
  const templates = await listTemplates();
  const result = await p.select({
    message: "Which template would you like to use?",
    options: templates.map((t) => ({
      value: t.name,
      label: t.name,
      hint: t.description,
    })),
    initialValue: DEFAULT_TEMPLATE,
  });
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled");
    process.exit(0);
  }
  return result;
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

/** Install deps with pnpm (scaffold declares packageManager: pnpm). */
async function installDeps(cwd: string): Promise<void> {
  if (await fileExists(path.join(cwd, "node_modules"))) return;

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
  if (deps.length === 0 && devDeps.length === 0) return;

  await ensurePnpm();

  const s = p.spinner();
  s.start("Installing dependencies with pnpm");

  try {
    // In dev mode, allow workspace resolution so @alexkroman1/* deps link to local source.
    // In production, --ignore-workspace prevents pnpm from hoisting to a parent workspace.
    const args = isDevMode() ? ["install"] : ["install", "--ignore-workspace"];
    await execFileAsync("pnpm", args, { cwd });
    s.stop("Dependencies installed");
  } catch (err: unknown) {
    const msg = errorMessage(err);
    s.stop("Dependency install failed");
    log.warn(`pnpm install failed: ${msg}`);
    log.warn("Run `corepack enable && pnpm install` manually in the project directory.");
  }
}

/** Resolve target directory — in dev mode, place under monorepo tmp/. */
function resolveTargetDir(dir: string, monorepoRoot: string | null): string {
  return monorepoRoot ? path.resolve(monorepoRoot, "tmp", dir) : path.resolve(resolveCwd(), dir);
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

/** Print post-init instructions. */
function printPostInitInfo(dir: string, monorepoRoot: string | null): void {
  log.success(`Created ${dir}`);
  const cdTarget = monorepoRoot ? `tmp/${dir}` : dir;
  if (monorepoRoot) log.info("Dev mode: project linked to workspace packages");
  log.info(`Next: cd ${cdTarget} && aai dev`);
}

export async function executeInit(
  opts: {
    dir?: string | undefined;
    template?: string | undefined;
    force?: boolean | undefined;
    yes?: boolean | undefined;
    skipApi?: boolean | undefined;
    skipDeploy?: boolean | undefined;
    server?: string | undefined;
  },
  extra?: { quiet?: boolean | undefined },
): Promise<CommandResult<InitData>> {
  if (!extra?.quiet) {
    p.intro(colorize("cyanBright", "Create a new voice agent"));
  }

  if (!opts.skipApi) {
    await ensureApiKeyInEnv();
  }

  const dir = opts.dir ?? (await promptProjectName(opts.yes));
  const monorepoRoot = getMonorepoRoot();
  const cwd = resolveTargetDir(dir, monorepoRoot);

  if (!opts.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error(
      `agent.ts already exists in this directory. Use ${colorize("cyanBright", "--force")} to overwrite.`,
    );
  }

  const template = opts.template ?? (await promptTemplate(opts.yes));

  const s = p.spinner();
  s.start(`Creating ${dir} from ${template} template`);

  const { runInit } = await import("./_init.ts");
  await runInit({ targetDir: cwd, template });
  s.stop("Project created");

  await installDeps(cwd);

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

  if (!extra?.quiet) {
    printPostInitInfo(dir, monorepoRoot);
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
