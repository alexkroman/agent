// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { BundleError, type BundleOutput, bundleAgent } from "./_bundler.ts";
import { type AgentEntry, loadAgent } from "./_discover.ts";
import { execFileAsync } from "./_exec.ts";
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
  await Promise.all([
    fs.writeFile(path.join(buildDir, "worker.js"), bundle.worker),
    fs.writeFile(path.join(buildDir, "index.html"), bundle.html),
  ]);
}

/**
 * Run `tsc --noEmit` on the agent project to type-check user files.
 * Fails the build on any errors.
 */
async function checkAgent(agentDir: string): Promise<void> {
  // Only check user files, not node_modules or .aai/
  const userFiles = ["agent.ts"];
  for (const f of ["client.tsx", "components.tsx"]) {
    try {
      await fs.stat(path.join(agentDir, f));
      userFiles.push(f);
    } catch {
      // file doesn't exist
    }
  }
  const checks = [{ args: ["--noEmit", ...userFiles], label: "Type-check" }];
  const results = await Promise.allSettled(
    checks.map(({ args }) => execFileAsync("npx", ["tsc", ...args], { cwd: agentDir })),
  );
  const errors: string[] = [];
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      const label = checks[i]?.label ?? "unknown";
      const msg = (r.reason as { stderr?: string }).stderr?.trim() ?? String(r.reason);
      logError(`${label}: ${msg}`);
      errors.push(label);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${errors.join(", ")} failed — fix the errors above`);
  }
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
    throw new Error("No agent found — run `aai new` first");
  }

  step("Check", agent.slug);
  await checkAgent(opts.agentDir);

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
