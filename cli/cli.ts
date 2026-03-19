// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import minimist from "minimist";
import { rootHelp } from "./_help.ts";
import { runDeployCommand } from "./deploy.tsx";
import { runDevCommand } from "./dev.tsx";
import { runInitCommand } from "./init.tsx";
import { runRagCommand } from "./rag.tsx";
import { runSecretCommand } from "./secret.tsx";
import { runStartCommand } from "./start.tsx";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
// Read version from root package.json (single-package repo)
const pkgJsonPath = path.join(cliDir, "..", "package.json");
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
const VERSION: string = pkgJson.version;

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
    case "init":
      await runInitCommand(subArgs, VERSION);
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
    case "secret":
      await runSecretCommand(subArgs, VERSION);
      return;
    case "rag":
      await runRagCommand(subArgs, VERSION);
      return;
    case "help":
      console.log(rootHelp(VERSION));
      return;
    case undefined:
      await runInitCommand(subArgs, VERSION);
      return;
    default:
      console.error(`Unknown command: ${subcommand}`);
      console.log(rootHelp(VERSION));
      process.exit(1);
  }
}

if (process.env.VITEST !== "true") {
  process.on("SIGINT", () => process.exit(0));
  try {
    await main(process.argv.slice(2));
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Entry point for the `aai` CLI. Parses top-level arguments and dispatches
 * to the appropriate subcommand (`init`, `deploy`, `secret`, etc.).
 */
export { main };
