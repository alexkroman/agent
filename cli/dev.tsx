/** @jsxImportSource react */
// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import minimist from "minimist";
import { _startDevServer } from "./_dev.ts";
import { fileExists, getApiKey } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { runWithInk, Step } from "./_ink.tsx";
import { runInitCommand } from "./init.tsx";

const devCommandDef: SubcommandDef = {
  name: "dev",
  description: "Start a local development server",
  options: [
    {
      flags: "-p, --port <number>",
      description: "Port to listen on (default: 3000)",
    },
    { flags: "-y, --yes", description: "Accept defaults (no prompts)" },
  ],
};

/**
 * Runs the `aai dev` subcommand. Starts a local development server
 * that imports the agent directly and serves the bundled client UI.
 */
export async function runDevCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    string: ["port"],
    boolean: ["help", "yes"],
    alias: { p: "port", h: "help", y: "yes" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(devCommandDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();
  const port = Number.parseInt(parsed.port ?? "3000", 10);

  // If no agent.ts exists, scaffold first (may prompt for template)
  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    await runInitCommand(parsed.yes ? ["-y"] : [], version, { quiet: true });
  }

  // Pre-resolve API key (may prompt) before Ink render
  await getApiKey();

  await runWithInk(async (log) => {
    log(<Step action="Dev" msg={`starting on port ${port}`} />);
    await _startDevServer(cwd, port, log);
  });
}
