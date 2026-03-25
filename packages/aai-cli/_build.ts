// Copyright 2025 the AAI authors. MIT license.

import { BundleError, type BundleOutput, bundleAgent } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { runCommand, step } from "./_ui.ts";

/**
 * Discover the agent entry and bundle both worker and client.
 *
 * Shared by `aai build`, `aai dev`, and `aai deploy`.
 */
export async function buildAgentBundle(
  cwd: string,
  log: (msg: string) => void,
): Promise<BundleOutput> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  log(step("Bundle", agent.slug));
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
  log(`worker: ${kb} KB, client: ${clientCount} file(s)`);

  return bundle;
}

/** Bundle the agent and report success. Used by `aai build`. */
export async function runBuildCommand(cwd: string): Promise<void> {
  await runCommand(async ({ log }) => {
    await buildAgentBundle(cwd, log);
    log(step("Build", "ok"));
  });
}
