// Copyright 2025 the AAI authors. MIT license.

import { spawn } from "node:child_process";
import minimist from "minimist";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { step } from "./_output.ts";

const upgradeDef: SubcommandDef = {
  name: "upgrade",
  description: "Update @aai packages to the latest versions",
  options: [],
};

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Runs `npm update` scoped to `@aai/*` packages to refresh
 * the lockfile and node_modules.
 */
export async function runUpgradeCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, { boolean: ["help"], alias: { h: "help" } });
  if (parsed.help) {
    console.log(subcommandHelp(upgradeDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();

  step("Update", "@aai packages");
  await run("npm", ["update", "@aai/sdk", "@aai/ui"], cwd);

  step("Install", "refreshing lockfile");
  await run("npm", ["install"], cwd);
}
