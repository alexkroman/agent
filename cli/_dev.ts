// Copyright 2025 the AAI authors. MIT license.

import React from "react";
import { BundleError, bundleAgent } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
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
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  log(React.createElement(Step, { action: "Build", msg: agent.slug }));
  let clientDir: string;
  try {
    const bundle = await bundleAgent(agent);
    clientDir = bundle.clientDir;
  } catch (err) {
    if (err instanceof BundleError) {
      throw new Error(`Bundle failed: ${err.message}`);
    }
    throw err;
  }

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  await bootServer(agentDef, clientDir, env, port);
  log(React.createElement(Step, { action: "Ready", msg: `http://localhost:${port}` }));
}
