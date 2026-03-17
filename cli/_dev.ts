// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { BundleError, bundleAgent } from "./_bundler.ts";
import { getApiKey, loadAgent } from "./_discover.ts";
import { error as logError, step } from "./_output.ts";

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

  // Write client.js to .aai/ for local serving
  const aaiDir = path.join(cwd, ".aai");
  await fs.mkdir(aaiDir, { recursive: true });

  // Dynamically import the agent module to get the AgentDef
  step("Load", "agent.ts");
  const agentPath = path.resolve(cwd, "agent.ts");
  const agentModule = await import(agentPath);
  const agentDef = agentModule.default;

  if (!agentDef || typeof agentDef !== "object" || !agentDef.name) {
    throw new Error("agent.ts must export a default agent definition (from defineAgent())");
  }

  // Load env vars — try to get AssemblyAI API key
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (!env.ASSEMBLYAI_API_KEY) {
    try {
      env.ASSEMBLYAI_API_KEY = await getApiKey();
    } catch {
      logError("ASSEMBLYAI_API_KEY not set. Set it in your environment or run `aai env add`.");
    }
  }

  // Create and start the server
  step("Start", `http://localhost:${port}`);
  const { createServer } = await import("aai/server");
  const server = createServer({
    agent: agentDef,
    clientHtml: html,
    env,
  });

  step("Ready", `http://localhost:${port}`);
  await server.listen(port);
}
