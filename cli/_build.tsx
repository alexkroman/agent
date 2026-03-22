// Copyright 2025 the AAI authors. MIT license.

import type { ReactNode } from "react";
import { errorMessage } from "../sdk/_utils.ts";
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
  log: (node: ReactNode) => void,
  opts?: { skipRenderCheck?: boolean },
): Promise<BundleOutput> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  log(<Step action="Bundle" msg={agent.slug} />);
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
  log(<Info msg={`worker: ${kb} KB, client: ${clientCount} file(s)`} />);

  if (agent.clientEntry && !opts?.skipRenderCheck) {
    // Dynamic import: linkedom is a devDependency — skip render check if unavailable.
    const renderCheckPath = "../sdk/_render_check.ts";
    const mod = await import(/* @vite-ignore */ renderCheckPath).catch(() => null);
    if (mod) {
      log(<Step action="Render" msg="check" />);
      try {
        await mod.renderCheck(agent.clientEntry, cwd);
      } catch (err) {
        throw new Error(`Render check failed: ${errorMessage(err)}`);
      }
    }
  }

  return bundle;
}
