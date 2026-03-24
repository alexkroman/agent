// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fileExists, getApiKey, isDevMode, resolveCwd } from "./_discover.ts";
import { interactive, runWithInk, Step, Warn } from "./_ink.tsx";
import { askText } from "./_prompts.tsx";

const execFileAsync = promisify(execFile);

/** Install deps — uses `aai link` in dev mode, `npm install` otherwise. */
async function installDeps(cwd: string, log: (el: React.ReactNode) => void): Promise<void> {
  if (await fileExists(path.join(cwd, "node_modules"))) return;

  if (isDevMode()) {
    log(<Step action="Link" msg="local workspace packages (dev mode)" />);
    const { runLinkCommand } = await import("./_link.ts");
    runLinkCommand(cwd);
    return;
  }

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
    log(<Step action="Install" msg={deps.join(", ")} />);
  }
  if (devDeps.length > 0) {
    log(<Step action="Install" msg={`dev: ${devDeps.join(", ")}`} />);
  }

  try {
    await execFileAsync("npm", ["install"], { cwd });
  } catch {
    log(<Warn msg="npm install failed" />);
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
    await getApiKey();
  }

  let dir = opts.dir;
  if (!dir) {
    dir = await askText("What is your project named?", "my-voice-agent");
  }
  const cwd = path.resolve(resolveCwd(), dir);

  if (!opts.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    throw new Error(
      `agent.ts already exists in this directory. Use ${interactive("--force")} to overwrite.`,
    );
  }

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  // When running from dist/, templates are one level up
  const templatesDir = existsSync(path.join(cliDir, "templates"))
    ? path.join(cliDir, "templates")
    : path.join(cliDir, "..", "templates");
  const { runInit } = await import("./_init.ts");
  const template = opts.template || "simple";

  await runWithInk(async ({ log }) => {
    log(<Step action="Create" msg={dir} />);
    await runInit({ targetDir: cwd, template, templatesDir });
    await installDeps(cwd, log);
  });

  process.chdir(cwd);
  delete process.env.INIT_CWD;

  if (!(opts.skipDeploy || extra?.quiet)) {
    const { runDeployCommand } = await import("./deploy.tsx");
    await runDeployCommand({ cwd });
  }

  return cwd;
}
