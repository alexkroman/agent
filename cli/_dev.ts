// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import React from "react";
import { BundleError, bundleAgent } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { Step } from "./_ink.tsx";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

/**
 * Start a local development server.
 *
 * 1. Bundles the agent (same pipeline as deploy) to get client files
 * 2. Loads agent.ts via Vite SSR to get the AgentDef
 * 3. Boots a local server with createServer()
 */
export async function _startDevServer(
  cwd: string,
  port: number,
  log: (node: React.ReactNode) => void,
): Promise<void> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  log(React.createElement(Step, { action: "Bundle", msg: agent.slug }));
  let clientDir: string;
  try {
    await bundleAgent(agent);
    clientDir = path.join(agent.dir, ".aai", "client");
  } catch (err) {
    if (err instanceof BundleError) {
      throw new Error(`Bundle failed: ${err.message}`);
    }
    throw err;
  }

  log(React.createElement(Step, { action: "Load", msg: "agent.ts" }));
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();

  log(React.createElement(Step, { action: "Start", msg: `http://localhost:${port}` }));
  await bootServer(agentDef, clientDir, env, port);
  log(React.createElement(Step, { action: "Ready", msg: `http://localhost:${port}` }));
}
