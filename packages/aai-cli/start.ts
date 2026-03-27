// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { fileExists } from "./_discover.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server-common.ts";
import { parsePort, runCommand, step } from "./_ui.ts";

export async function _startProductionServer(
  cwd: string,
  port: number,
  log: (msg: string) => void,
): Promise<void> {
  const clientDir = path.join(cwd, ".aai", "client");

  log(step("Start", "loading agent"));
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv(cwd);

  await bootServer(agentDef, clientDir, env, port);
  log(step("Ready", `http://localhost:${port}`));
}

export async function runStartCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const buildDir = path.join(opts.cwd, ".aai", "build");

  if (!(await fileExists(path.join(buildDir, "worker.js")))) {
    throw new Error("No build found — run `aai build` first");
  }

  await runCommand(async ({ log }) => {
    log(step("Start", `production server on port ${port}`));
    await _startProductionServer(opts.cwd, port, log);
  });
}
