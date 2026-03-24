// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai/utils";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";
import type { AgentEntry } from "./_discover.ts";

/**
 * Error thrown when bundling fails.
 *
 * @param message Human-readable error message (typically formatted build output).
 */
export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

/** Output artifacts produced by {@linkcode bundleAgent}. */
export type BundleOutput = {
  /** Minified ESM JavaScript for the server-side worker. */
  worker: string;
  /** All client build files keyed by relative path (e.g. "index.html", "assets/index-abc123.js"). */
  clientFiles: Record<string, string>;
  /** Absolute path to the client build directory on disk. */
  clientDir: string;
  /** Size of the worker bundle in bytes. */
  workerBytes: number;
};

/** Vite plugin that provides a virtual worker entry module (no file on disk). */
function workerEntryPlugin(agentDir: string): Plugin {
  const virtualId = "virtual:worker-entry";
  const resolvedId = `\0${virtualId}`;
  const agentPath = path.join(agentDir, "agent.ts");
  return {
    name: "aai-worker-entry",
    resolveId(source) {
      return source === virtualId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      return `import agent from ${JSON.stringify(agentPath)}; module.exports = agent;`;
    },
  };
}

/** Read all files in a directory as a map of relative paths to contents. */
async function readDirFiles(dir: string): Promise<Record<string, string>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return {};
  }
  const files: Record<string, string> = {};
  await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const full = path.join(e.parentPath, e.name);
        files[path.relative(dir, full)] = await fs.readFile(full, "utf-8");
      }),
  );
  return files;
}

/**
 * Bundles an agent project into deployable artifacts using Vite.
 *
 * Writes all output to `.aai/` on disk:
 * - `.aai/build/worker.js` — the platform worker bundle
 * - `.aai/client/` — standard Vite multi-file output (index.html + assets/)
 *
 * Both `aai dev` and `aai deploy` use this function identically.
 */
export async function bundleAgent(
  agent: AgentEntry,
  opts?: { skipClient?: boolean },
): Promise<BundleOutput> {
  const aaiDir = path.join(agent.dir, ".aai");
  const buildDir = path.join(aaiDir, "build");
  const clientDir = path.join(aaiDir, "client");

  // 1. Worker build — bundles agent.ts into a single CJS file for V8 isolate execution
  try {
    await build({
      configFile: false,
      root: agent.dir,
      logLevel: "warn",
      plugins: [workerEntryPlugin(agent.dir)],
      build: {
        rollupOptions: {
          input: "virtual:worker-entry",
          output: { format: "cjs", entryFileNames: "worker.js", exports: "named" },
        },
        outDir: buildDir,
        emptyOutDir: true,
        minify: true,
        target: "es2022",
      },
    });
  } catch (err: unknown) {
    throw new BundleError(errorMessage(err));
  }

  // 2. Client build — standard Vite multi-file output (index.html + assets/)
  const skipClient = opts?.skipClient || !agent.clientEntry;

  if (!skipClient) {
    try {
      await build({
        root: agent.dir,
        base: "./",
        logLevel: "warn",
        plugins: [preact(), tailwindcss()],
        resolve: {
          dedupe: ["preact", "@preact/signals"],
        },
        build: {
          outDir: clientDir,
          emptyOutDir: true,
          minify: true,
          target: "es2022",
        },
      });
    } catch (err: unknown) {
      throw new BundleError(errorMessage(err));
    }
  }

  const worker = await fs.readFile(path.join(buildDir, "worker.js"), "utf-8");
  const clientFiles = await readDirFiles(clientDir);

  return {
    worker,
    clientFiles,
    clientDir,
    workerBytes: Buffer.byteLength(worker),
  };
}
