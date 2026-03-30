// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { fileExists } from "./_discover.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server-common.ts";
import { consola, parsePort } from "./_ui.ts";

export async function _startProductionServer(cwd: string, port: number): Promise<void> {
  const clientDir = path.join(cwd, ".aai", "client");

  consola.start("Loading agent");
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv(cwd);

  await bootServer(agentDef, clientDir, env, port);
  consola.success(`Ready http://localhost:${port}`);
}

export async function runStartCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const buildDir = path.join(opts.cwd, ".aai", "build");

  if (!(await fileExists(path.join(buildDir, "worker.js")))) {
    throw new Error("No build found — run `aai build` first");
  }

  consola.start(`Starting server on port ${port}`);
  await _startProductionServer(opts.cwd, port);
}
