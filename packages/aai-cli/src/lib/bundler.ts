// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai/utils";
import { build } from "vite";
import type { AgentEntry } from "./discover.ts";

export class BundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleError";
  }
}

export type BundleOutput = {
  slug: string;
  worker: string;
  clientFiles: Record<string, string>;
  workerBytes: number;
};

/**
 * Bundle an agent project.
 *
 * - Worker: SSR build of `tools.ts` via Vite
 * - Client: static `index.html` read as-is (no build step)
 */
export async function bundleAgent(agent: AgentEntry): Promise<BundleOutput> {
  const aaiDir = path.join(agent.dir, ".aai");
  const buildDir = path.join(aaiDir, "build");

  // Bundle tools.ts into worker.js (or create empty worker if no tools)
  let worker: string;
  if (agent.toolsEntry) {
    try {
      await build({
        root: agent.dir,
        logLevel: "warn",
        build: {
          ssr: agent.toolsEntry,
          outDir: buildDir,
          emptyOutDir: true,
          rollupOptions: {
            output: { entryFileNames: "worker.js" },
          },
        },
      });
    } catch (err: unknown) {
      throw new BundleError(errorMessage(err), { cause: err });
    }
    worker = await fs.readFile(path.join(buildDir, "worker.js"), "utf-8");
  } else {
    // No tools.ts — agent has no custom tools, create minimal worker
    worker = "export default {};";
    await fs.mkdir(buildDir, { recursive: true });
    await fs.writeFile(path.join(buildDir, "worker.js"), worker);
  }

  // Read static index.html if present
  const clientFiles: Record<string, string> = {};
  if (agent.clientEntry) {
    clientFiles["index.html"] = await fs.readFile(agent.clientEntry, "utf-8");
  }

  return {
    slug: agent.slug,
    worker,
    clientFiles,
    workerBytes: Buffer.byteLength(worker),
  };
}

export async function buildAgentBundle(cwd: string): Promise<BundleOutput> {
  const { loadAgentEntry } = await import("./discover.ts");
  const { log } = await import("./ui.ts");

  const agent = await loadAgentEntry(cwd);
  if (!agent) throw new Error("No agent.toml found — run `aai init` first");

  log.step(`Bundling ${agent.slug}`);
  try {
    return await bundleAgent(agent);
  } catch (err: unknown) {
    if (err instanceof BundleError) throw new Error(`Build failed: ${err.message}`, { cause: err });
    throw err;
  }
}

export async function runBuildCommand(cwd: string): Promise<void> {
  const { log } = await import("./ui.ts");
  await buildAgentBundle(cwd);
  log.success("Build complete");
}
