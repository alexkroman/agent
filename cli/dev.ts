// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import minimist from "minimist";
import { _startDevServer } from "./_dev.ts";
import { fileExists } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { step } from "./_output.ts";
import { runNewCommand } from "./new.ts";

const devCommandDef: SubcommandDef = {
  name: "dev",
  description: "Start a local development server",
  options: [{ flags: "-p, --port <number>", description: "Port to listen on (default: 3000)" }],
};

/**
 * Runs the `aai dev` subcommand. Starts a local development server
 * that imports the agent directly and serves the bundled client UI.
 */
export async function runDevCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    string: ["port"],
    boolean: ["help"],
    alias: { p: "port", h: "help" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(devCommandDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();
  const port = parseInt(parsed.port ?? "3000", 10);

  // If no agent.ts exists, scaffold first
  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    await runNewCommand([], version);
  }

  step("Dev", `starting on port ${port}`);
  await _startDevServer(cwd, port);
}
