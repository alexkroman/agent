// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import React from "react";
import { Step } from "./_ink.tsx";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

/**
 * Start a production server from built artifacts.
 *
 * 1. Reads client files from .aai/client/
 * 2. Imports agent.ts to get the AgentDef
 * 3. Calls createServer() from the SDK to start the server
 */
export async function _startProductionServer(
  cwd: string,
  port: number,
  log: (node: React.ReactNode) => void,
): Promise<void> {
  const clientDir = path.join(cwd, ".aai", "client");

  log(React.createElement(Step, { action: "Load", msg: "agent" }));
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();

  log(React.createElement(Step, { action: "Start", msg: `http://localhost:${port}` }));
  await bootServer(agentDef, clientDir, env, port, cwd);
  log(React.createElement(Step, { action: "Ready", msg: `http://localhost:${port}` }));
}
