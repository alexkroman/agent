// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { colorize } from "consola/utils";
import { ensureApiKeyInEnv, fileExists, resolveCwd } from "./_discover.ts";
import { askText } from "./_prompts.ts";
import { consola } from "./_ui.ts";

const execFileAsync = promisify(execFile);

/** Install deps via npm install. */
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

  if (deps.length > 0) {
    consola.start(`Install ${deps.join(", ")}`);
  }
  if (devDeps.length > 0) {
    consola.start(`Install dev: ${devDeps.join(", ")}`);
  }

  try {
    await execFileAsync("npm", ["install"], { cwd });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    consola.warn(`npm install failed: ${msg}`);
    consola.warn("Run `npm install` manually in the project directory to install dependencies.");
  }
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
  if (!opts.skipApi) {
    await ensureApiKeyInEnv();
  }

  let dir = opts.dir;
  if (!dir) {
    dir = await askText("What is your project named?", "my-voice-agent");
  }
  const cwd = path.resolve(resolveCwd(), dir);

  if (!opts.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error(
      `agent.ts already exists in this directory. Use ${colorize("blueBright", "--force")} to overwrite.`,
    );
  }

  const { runInit } = await import("./_init.ts");
  const template = opts.template ?? "simple";

  consola.start(`Create ${dir}`);
  await runInit({ targetDir: cwd, template });
  await installDeps(cwd);

  if (!(opts.skipDeploy || extra?.quiet)) {
    const { runDeployCommand } = await import("./deploy.ts");
    await runDeployCommand({ cwd });
  }

  return cwd;
}
