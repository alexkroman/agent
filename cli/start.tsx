// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import React from "react";
import { fileExists } from "./_discover.ts";
import { runWithInk, Step } from "./_ink.tsx";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

export async function _startProductionServer(
  cwd: string,
  port: number,
  log: (node: React.ReactNode) => void,
): Promise<void> {
  const clientDir = path.join(cwd, ".aai", "client");

  log(React.createElement(Step, { action: "Start", msg: "loading agent" }));
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();

  await bootServer(agentDef, clientDir, env, port);
  log(React.createElement(Step, { action: "Ready", msg: `http://localhost:${port}` }));
}

export async function runStartCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = Number.parseInt(opts.port, 10);
  const buildDir = path.join(opts.cwd, ".aai", "build");

  if (!(await fileExists(path.join(buildDir, "worker.js")))) {
    throw new Error("No build found — run `aai build` first");
  }

  await runWithInk(async ({ log }) => {
    log(<Step action="Start" msg={`production server on port ${port}`} />);
    await _startProductionServer(opts.cwd, port, log);
  });
}
