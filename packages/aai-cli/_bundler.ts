// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai/utils";
import { build } from "vite";
import type { AgentEntry } from "./_discover.ts";

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
  clientDir: string;
  workerBytes: number;
};

const TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".json",
  ".map",
  ".svg",
  ".xml",
  ".txt",
  ".md",
]);

async function readDirFiles(dir: string): Promise<Record<string, string>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return {};
    throw err;
  }
  const files: Record<string, string> = {};
  await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const full = path.join(e.parentPath, e.name);
        const ext = path.extname(e.name).toLowerCase();
        const rel = path.relative(dir, full);
        if (TEXT_EXTENSIONS.has(ext)) {
          files[rel] = await fs.readFile(full, "utf-8");
        } else {
          const buf = await fs.readFile(full);
          files[rel] = `base64:${buf.toString("base64")}`;
        }
      }),
  );
  return files;
}

/**
 * Bundle an agent project using Vite.
 *
 * - Worker: `vite build --ssr agent.ts` (uses project's vite.config.ts)
 * - Client: `vite build` (uses project's vite.config.ts)
 */
export async function bundleAgent(
  agent: AgentEntry,
  opts?: { skipClient?: boolean },
): Promise<BundleOutput> {
  const aaiDir = path.join(agent.dir, ".aai");
  const buildDir = path.join(aaiDir, "build");
  const clientDir = path.join(aaiDir, "client");

  // 1. Worker — SSR build
  try {
    await build({
      root: agent.dir,
      logLevel: "warn",
      build: {
        ssr: path.join(agent.dir, "agent.ts"),
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

  // 2. Client — standard Vite build
  if (!(opts?.skipClient ?? !agent.clientEntry)) {
    try {
      await build({
        root: agent.dir,
        base: "./",
        logLevel: "warn",
        build: {
          outDir: clientDir,
          emptyOutDir: true,
        },
      });
    } catch (err: unknown) {
      throw new BundleError(errorMessage(err), { cause: err });
    }
  }

  const worker = await fs.readFile(path.join(buildDir, "worker.js"), "utf-8");
  const clientFiles = await readDirFiles(clientDir);

  return {
    slug: agent.slug,
    worker,
    clientFiles,
    clientDir,
    workerBytes: Buffer.byteLength(worker),
  };
}

export async function buildAgentBundle(cwd: string): Promise<BundleOutput> {
  const { loadAgent } = await import("./_discover.ts");
  const { log } = await import("./_ui.ts");

  const agent = await loadAgent(cwd);
  if (!agent) throw new Error("No agent found — run `aai init` first");

  log.step(`Bundling ${agent.slug}`);
  let bundle: BundleOutput;
  try {
    bundle = await bundleAgent(agent);
  } catch (err: unknown) {
    if (err instanceof BundleError) throw new Error(`Build failed: ${err.message}`, { cause: err });
    throw err;
  }

  return bundle;
}

export async function runBuildCommand(cwd: string): Promise<void> {
  const { log } = await import("./_ui.ts");
  await buildAgentBundle(cwd);
  log.success("Build complete");
}
