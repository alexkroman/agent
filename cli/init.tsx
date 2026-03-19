// Copyright 2025 the AAI authors. MIT license.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import minimist from "minimist";
import { interactive } from "./_colors.ts";
import { fileExists, isDevMode } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { runWithInk, Step } from "./_ink.tsx";
import { askText } from "./_prompts.tsx";

const execFileAsync = promisify(execFile);

/** CLI definition for the `aai init` subcommand. */
const initCommandDef: SubcommandDef = {
  name: "init",
  description: "Scaffold a new agent project",
  args: [{ name: "dir", optional: true }],
  options: [
    {
      flags: "-t, --template <template>",
      description: "Template to use",
    },
    { flags: "-f, --force", description: "Overwrite existing agent.ts" },
  ],
};

/** Rewrite @aai deps to local monorepo paths for dev mode. */
async function rewriteDevDeps(cwd: string, cliDir: string): Promise<void> {
  const monorepoRoot = path.join(cliDir, "..");
  const pkgJsonPath = path.join(cwd, "package.json");
  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));

  // Rewrite the main package to point at the local source
  const rootPkg = JSON.parse(await fs.readFile(path.join(monorepoRoot, "package.json"), "utf-8"));
  const rootPkgName = rootPkg.name as string;
  if (pkgJson.dependencies[rootPkgName]) {
    pkgJson.dependencies[rootPkgName] = `file:${monorepoRoot}`;
  }

  await fs.writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
}

/** Install npm dependencies, logging progress. */
async function installDeps(cwd: string, log: (el: React.ReactNode) => void): Promise<void> {
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
    log(<Step action="Install" msg={deps.join(", ")} />);
  }
  if (devDeps.length > 0) {
    log(<Step action="Install" msg={`dev: ${devDeps.join(", ")}`} />);
  }

  try {
    await execFileAsync("npm", ["install"], { cwd });
  } catch {
    log(<Step action="Skip" msg="npm install failed" />);
  }
}

/**
 * Runs the `aai init` subcommand. Scaffolds a new agent project from a
 * template and installs dependencies.
 */
export async function runInitCommand(
  args: string[],
  version: string,
  opts?: { quiet?: boolean },
): Promise<string> {
  const parsed = minimist(args, {
    string: ["template"],
    boolean: ["force", "help"],
    alias: { t: "template", f: "force", h: "help" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(initCommandDef, version));
    return "";
  }

  // Ensure API key is set before prompting for project name
  const { getApiKey } = await import("./_discover.ts");
  await getApiKey();

  let dir = parsed._[0] as string | undefined;
  if (!dir) {
    dir = await askText("What is your project named?", "my-voice-agent");
  }
  const cwd = path.resolve(process.env.INIT_CWD || process.cwd(), dir);

  if (!parsed.force && (await fileExists(path.join(cwd, "agent.ts")))) {
    console.log(
      `agent.ts already exists in this directory. Use ${interactive("--force")} to overwrite.`,
    );
    process.exit(1);
  }

  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const templatesDir = path.join(cliDir, "..", "templates");
  const { runInit } = await import("./_init.ts");
  const template = parsed.template || "simple";

  await runWithInk(async (log) => {
    log(<Step action="Create" msg={dir} />);
    await runInit({ targetDir: cwd, template, templatesDir });

    if (isDevMode()) {
      await rewriteDevDeps(cwd, cliDir);
    }

    await installDeps(cwd, log);
  });

  process.chdir(cwd);
  delete process.env.INIT_CWD;

  if (!opts?.quiet) {
    const { runDeployCommand } = await import("./deploy.tsx");
    await runDeployCommand(["-y"], version);
  }

  return cwd;
}
