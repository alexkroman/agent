// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { BundleError, bundleAgent } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { error as logError, step } from "./_output.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

/**
 * Start a local development server.
 *
 * 1. Bundles the agent (same pipeline as deploy) to get client files
 * 2. Loads agent.ts via Vite SSR to get the AgentDef
 * 3. Boots a local server with createServer()
 */
export async function _startDevServer(cwd: string, port: number): Promise<void> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  // Bundle using the same pipeline as deploy
  step("Bundle", agent.slug);
  let clientDir: string;
  try {
    await bundleAgent(agent);
    clientDir = path.join(agent.dir, ".aai", "client");
  } catch (err) {
    if (err instanceof BundleError) {
      logError(err.message);
      throw new Error("Bundle failed — fix the errors above");
    }
    throw err;
  }

  // Load agent def via Vite SSR (handles .ts imports from node_modules)
  step("Load", "agent.ts");
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  await bootServer(agentDef, clientDir, env, port, cwd);
}
