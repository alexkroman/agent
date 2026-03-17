// Copyright 2025 the AAI authors. MIT license.

import { BundleError, bundleAgent } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { error as logError, step } from "./_output.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

/**
 * Start a local development server.
 *
 * 1. Bundles client.tsx into HTML (via the existing bundler)
 * 2. Dynamically imports agent.ts to get the AgentDef
 * 3. Calls createServer() from the SDK to start the server
 */
export async function _startDevServer(cwd: string, port: number): Promise<void> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai new` first");
  }

  // Bundle the agent to get client HTML (and verify everything builds)
  step("Bundle", agent.slug);
  let html: string;
  try {
    const bundle = await bundleAgent(agent);
    html = bundle.html;
  } catch (err) {
    if (err instanceof BundleError) {
      logError(err.message);
      throw new Error("Bundle failed — fix the errors above");
    }
    throw err;
  }

  step("Load", "agent.ts");
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  await bootServer(agentDef, html, env, port);
}
