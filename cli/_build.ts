// Copyright 2025 the AAI authors. MIT license.

import React from "react";
import { BundleError, type BundleOutput, bundleAgent } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { Info, Step } from "./_ink.tsx";

/**
 * Discover the agent entry and bundle both worker and client.
 *
 * Shared by `aai build`, `aai dev`, and `aai deploy`.
 */
export async function buildAgentBundle(
  cwd: string,
  log: (node: React.ReactNode) => void,
): Promise<BundleOutput> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  log(React.createElement(Step, { action: "Bundle", msg: agent.slug }));
  let bundle: BundleOutput;
  try {
    bundle = await bundleAgent(agent);
  } catch (err) {
    if (err instanceof BundleError) {
      throw new Error(`Bundle failed: ${err.message}`);
    }
    throw err;
  }

  const kb = (bundle.workerBytes / 1024).toFixed(1);
  const clientCount = Object.keys(bundle.clientFiles).length;
  log(React.createElement(Info, { msg: `worker: ${kb} KB, client: ${clientCount} file(s)` }));

  if (agent.clientEntry) {
    try {
      const { renderCheck } = await import("../sdk/_render_check.ts");
      log(React.createElement(Step, { action: "Render", msg: "check" }));
      await renderCheck(agent.clientEntry, cwd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("linkedom")) return bundle;
      throw new Error(`Render check failed: ${msg}`);
    }
  }

  return bundle;
}
