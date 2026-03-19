// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { BundleError, type BundleOutput, bundleAgent } from "./_bundler.ts";
import { type AgentEntry, loadAgent } from "./_discover.ts";
import { error as logError, step } from "./_output.ts";

export type { BundleOutput } from "./_bundler.ts";

/** Result of a successful agent build, containing the discovered agent metadata and bundled output. */
export type BuildResult = {
  agent: AgentEntry;
  bundle: BundleOutput;
};

/** Options for {@linkcode runBuild}. */
export type BuildOpts = {
  /** Absolute path to the directory containing `agent.ts`. */
  agentDir: string;
};

/**
 * Writes build artifacts to the `.aai/build/` directory inside the agent
 * project, similar to how Next.js writes to `.next/`.
 */
async function writeBuildOutput(agentDir: string, bundle: BundleOutput): Promise<void> {
  const buildDir = path.join(agentDir, ".aai", "build");
  await fs.mkdir(buildDir, { recursive: true });
  const writes = [fs.writeFile(path.join(buildDir, "worker.js"), bundle.worker)];
  for (const [relPath, content] of Object.entries(bundle.clientFiles)) {
    const fullPath = path.join(buildDir, "client", relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    writes.push(fs.writeFile(fullPath, content));
  }
  await Promise.all(writes);
}

/**
 * Discovers the agent in the given directory and bundles it into deployable
 * JavaScript artifacts (worker + client).
 *
 * @param opts Build options specifying the agent directory.
 * @returns The discovered agent metadata and bundle output.
 * @throws If no `agent.ts` is found or the bundle fails.
 */
export async function runBuild(opts: BuildOpts): Promise<BuildResult> {
  const agent = await loadAgent(opts.agentDir);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  step("Bundle", agent.slug);
  let bundle: BundleOutput;
  try {
    bundle = await bundleAgent(agent);
  } catch (err) {
    if (err instanceof BundleError) {
      logError(err.message);
      throw new Error("Bundle failed — fix the errors above");
    }
    throw err;
  }

  await writeBuildOutput(opts.agentDir, bundle);

  return { agent, bundle };
}
