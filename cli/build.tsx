// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import minimist from "minimist";
import { buildAgentBundle } from "./_build.ts";
import { fileExists } from "./_discover.ts";
import type { SubcommandDef } from "./_help.ts";
import { subcommandHelp } from "./_help.ts";
import { runWithInk, Step } from "./_ink.tsx";
import { runInitCommand } from "./init.tsx";

const buildCommandDef: SubcommandDef = {
  name: "build",
  description: "Bundle agent and client (validates code without deploying or starting a server)",
  options: [{ flags: "-y, --yes", description: "Accept defaults (no prompts)" }],
};

/**
 * Runs the `aai build` subcommand. Bundles both the worker and client,
 * validating that all imports resolve and JSX compiles. Exits with a
 * non-zero code on failure so CI and Claude Code can detect broken code.
 */
export async function runBuildCommand(args: string[], version: string): Promise<void> {
  const parsed = minimist(args, {
    boolean: ["help", "yes"],
    alias: { h: "help", y: "yes" },
  });

  if (parsed.help) {
    console.log(subcommandHelp(buildCommandDef, version));
    return;
  }

  const cwd = process.env.INIT_CWD || process.cwd();

  if (!(await fileExists(path.join(cwd, "agent.ts")))) {
    await runInitCommand(parsed.yes ? ["-y"] : [], version, { quiet: true });
  }

  await runWithInk(async (log) => {
    await buildAgentBundle(cwd, log);
    log(<Step action="Build" msg="ok" />);
  });
}
