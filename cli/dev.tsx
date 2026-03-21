// Copyright 2025 the AAI authors. MIT license.

import React from "react";
import { buildAgentBundle } from "./_build.ts";
import { runWithInk, Step } from "./_ink.tsx";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

export async function _startDevServer(
  cwd: string,
  port: number,
  log: (node: React.ReactNode) => void,
): Promise<void> {
  const bundle = await buildAgentBundle(cwd, log, { skipRenderCheck: true });

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  await bootServer(agentDef, bundle.clientDir, env, port);
  log(React.createElement(Step, { action: "Ready", msg: `http://localhost:${port}` }));
}

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = Number.parseInt(opts.port, 10);

  await runWithInk(async ({ log }) => {
    await _startDevServer(opts.cwd, port, log);
  });
}
