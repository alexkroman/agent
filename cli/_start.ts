// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { step } from "./_output.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

/**
 * Start a production server from built artifacts.
 *
 * 1. Reads client files from .aai/client/
 * 2. Imports agent.ts to get the AgentDef
 * 3. Calls createServer() from the SDK to start the server
 */
export async function _startProductionServer(cwd: string, port: number): Promise<void> {
  const clientDir = path.join(cwd, ".aai", "client");

  step("Load", "agent");
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  await bootServer(agentDef, clientDir, env, port, cwd);
}
