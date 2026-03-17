// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import minimist from "minimist";
import { rootHelp } from "./_help.ts";
import { error } from "./_output.ts";
import { promptUpgradeIfAvailable } from "./_update.ts";
import { runDeployCommand } from "./deploy.ts";
import { runDevCommand } from "./dev.ts";
import { runEnvCommand } from "./env.ts";
import { runNewCommand } from "./new.ts";
import { runRagCommand } from "./rag.ts";
import { runStartCommand } from "./start.ts";
import { runUpgradeCommand } from "./upgrade.ts";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
// Read version from root package.json (single-package repo)
const pkgJsonPath = path.join(cliDir, "..", "package.json");
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
const VERSION: string = pkgJson.version;

// Skip update check when running via `node` (dev mode) — only check for compiled binary
const isCompiled = path.basename(process.argv[0] ?? "") === "aai";
if (isCompiled) {
  await promptUpgradeIfAvailable(VERSION);
}

async function main(args: string[]): Promise<void> {
  const parsed = minimist(args, {
    boolean: ["help", "version"],
    alias: { h: "help", V: "version" },
    stopEarly: true,
  });

  if (parsed.version) {
    console.log(VERSION);
    return;
  }

  if (parsed.help && parsed._.length === 0) {
    console.log(rootHelp(VERSION));
    return;
  }

  const [subcommand, ...rest] = parsed._;
  const subArgs = rest.map(String);

  switch (subcommand) {
    case "new":
      await runNewCommand(subArgs, VERSION);
      return;
    case "deploy":
      await runDeployCommand(subArgs, VERSION);
      return;
    case "dev":
      await runDevCommand(subArgs, VERSION);
      return;
    case "start":
      await runStartCommand(subArgs, VERSION);
      return;
    case "env":
      await runEnvCommand(subArgs, VERSION);
      return;
    case "rag":
      await runRagCommand(subArgs, VERSION);
      return;
    case "upgrade":
      await runUpgradeCommand(subArgs, VERSION);
      return;
    case "help":
      console.log(rootHelp(VERSION));
      return;
    case undefined:
      // Default: scaffold (if needed) + deploy
      await runDeployCommand(args, VERSION);
      return;
    default:
      error(`Unknown command: ${subcommand}`);
      console.log(rootHelp(VERSION));
      process.exit(1);
  }
}

// Detect if this is the main module
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main(process.argv.slice(2));
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Entry point for the `aai` CLI. Parses top-level arguments and dispatches
 * to the appropriate subcommand (`new`, `deploy`, or `help`).
 *
 * @param args Command-line arguments (typically `process.argv.slice(2)`).
 * @returns Resolves when the subcommand completes.
 * @throws If an unknown subcommand is provided or the subcommand fails.
 */
export { main };
