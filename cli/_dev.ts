// Copyright 2025 the AAI authors. MIT license.

import React from "react";
import { buildAgentBundle } from "./_build.ts";
import { Step } from "./_ink.tsx";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

/**
 * Start a local development server.
 *
 * Uses the same bundle pipeline as deploy, then serves locally.
 */
export async function _startDevServer(
  cwd: string,
  port: number,
  log: (node: React.ReactNode) => void,
): Promise<void> {
  const bundle = await buildAgentBundle(cwd, log);

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  await bootServer(agentDef, bundle.clientDir, env, port);
  log(React.createElement(Step, { action: "Ready", msg: `http://localhost:${port}` }));
}
