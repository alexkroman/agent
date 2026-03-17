// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import minimist from "minimist";
import { fileExists } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { step } from "./_output.ts";
import { _startProductionServer } from "./_start.ts";

const startCommandDef: SubcommandDef = {
  name: "start",
  description: "Start the production server from a build",
  options: [{ flags: "-p, --port <number>", description: "Port to listen on (default: 3000)" }],
};

/**
 * Runs the `aai start` subcommand. Starts a production server from
 * the built artifacts in `.aai/build/`.
 */
export async function runStartCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    string: ["port"],
    boolean: ["help"],
    alias: { p: "port", h: "help" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(startCommandDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();
  const port = parseInt(parsed.port ?? "3000", 10);
  const buildDir = path.join(cwd, ".aai", "build");

  if (!(await fileExists(path.join(buildDir, "worker.js")))) {
    throw new Error("No build found — run `aai build` first");
  }

  step("Start", `production server on port ${port}`);
  await _startProductionServer(cwd, port);
}
