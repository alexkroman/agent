// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@alexkroman1/aai/utils";
import * as p from "@clack/prompts";
import { colorize } from "consola/utils";
import { ensureApiKeyInEnv, fileExists, resolveCwd } from "./_discover.ts";
import { listTemplates } from "./_templates.ts";
import { log } from "./_ui.ts";

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
    // --ignore-workspace prevents pnpm from hoisting to a parent workspace
    // (e.g. when scaffolding inside the monorepo during development).
    await execFileAsync("pnpm", ["install", "--ignore-workspace"], { cwd });
    s.stop("Dependencies installed");
  } catch (err: unknown) {
    const msg = errorMessage(err);
    s.stop("Dependency install failed");
    log.warn(`pnpm install failed: ${msg}`);
    log.warn("Run `corepack enable && pnpm install` manually in the project directory.");
  }
}

/** Format the dev command for the "Next steps" note. */
function devCommand(): string {
  return "aai dev";
}

export async function runInitCommand(
  opts: {
    dir?: string | undefined;
    template?: string | undefined;
    force?: boolean | undefined;
    yes?: boolean | undefined;
    skipApi?: boolean | undefined;
    skipDeploy?: boolean | undefined;
  },
  extra?: { quiet?: boolean | undefined },
): Promise<string> {
  if (!extra?.quiet) {
    p.intro(colorize("cyanBright", "Create a new voice agent"));
  }

  if (!opts.skipApi) {
    await ensureApiKeyInEnv();
  }

  const dir = opts.dir ?? (await promptProjectName(opts.yes));
  const cwd = path.resolve(resolveCwd(), dir);

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

  if (!(opts.skipDeploy || extra?.quiet)) {
    const { runDeployCommand } = await import("./deploy.ts");
    await runDeployCommand({ cwd });
  }

  if (!extra?.quiet) {
    log.success(`Created ${dir}`);
    log.info(`Next: cd ${dir} && ${devCommand()}`);
  }

  return cwd;
}
