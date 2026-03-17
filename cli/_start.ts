// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { getApiKey } from "./_discover.ts";
import { error as logError, step } from "./_output.ts";

/**
 * Start a production server from built artifacts.
 *
 * 1. Reads worker.js and index.html from .aai/build/
 * 2. Evaluates the worker code to get the AgentDef
 * 3. Calls createServer() from the SDK to start the server
 */
export async function _startProductionServer(cwd: string, port: number): Promise<void> {
  const buildDir = path.join(cwd, ".aai", "build");

  // Read built artifacts
  const [html] = await Promise.all([fs.readFile(path.join(buildDir, "index.html"), "utf-8")]);

  // Import agent.ts directly (production still needs the source for direct execution)
  step("Load", "agent");
  const agentPath = path.resolve(cwd, "agent.ts");
  let agentDef: { name: string } | undefined;
  try {
    const agentModule = await import(agentPath);
    agentDef = agentModule.default;
  } catch {
    // Fallback: try to read the manifest for config
    const manifestPath = path.join(buildDir, "manifest.json");
    const manifestData = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestData);
    throw new Error(
      `Could not import agent.ts. For production, ensure agent.ts is available. ` +
        `Agent config: ${manifest.config?.name ?? "unknown"}`,
    );
  }

  if (!agentDef || typeof agentDef !== "object" || !agentDef.name) {
    throw new Error("agent.ts must export a default agent definition (from defineAgent())");
  }

  // Load env vars
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
