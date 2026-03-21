// Copyright 2025 the AAI authors. MIT license.

import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";
import type { AgentEntry } from "./_discover.ts";
import { isDevMode } from "./_discover.ts";

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

/** Internal helpers exposed for testing. Not part of the public API. */
export const _internals = {
  BundleError,
};

/**
 * Vite plugin that resolves @alexkroman1/aai imports to monorepo source.
 *
 * Reads the "source" condition from the monorepo's package.json exports,
 * so adding a new export automatically works in dev mode.
 */
function monorepoResolvePlugin(monorepoRoot: string): Plugin {
  const pkg = JSON.parse(readFileSync(path.join(monorepoRoot, "package.json"), "utf-8"));
  const sourceMap = new Map<string, string>();

  for (const [subpath, entry] of Object.entries(pkg.exports as Record<string, unknown>)) {
    if (typeof entry === "string") {
      // Plain string export (e.g. "./ui/styles.css": "./ui/styles.css")
      const specifier = `${pkg.name}/${subpath.slice(2)}`;
      sourceMap.set(specifier, path.resolve(monorepoRoot, entry));
    } else if (entry && typeof entry === "object" && "source" in entry) {
      const source = (entry as Record<string, string>).source;
      if (!source) continue;
      const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
      sourceMap.set(specifier, path.resolve(monorepoRoot, source));
    }
  }

  return {
    name: "aai-monorepo-resolve",
    resolveId(source) {
      return sourceMap.get(source) ?? null;
    },
  };
}

/** Vite plugin that provides a virtual worker entry module (no file on disk). */
function workerEntryPlugin(): Plugin {
  const virtualId = "virtual:worker-entry";
  const resolvedId = `\0${virtualId}`;
  return {
    name: "aai-worker-entry",
    resolveId(source) {
      return source === virtualId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      return [
        `import agent from "./agent.ts";`,
        `import { initWorker } from "@alexkroman1/aai/worker-shim";`,
        `initWorker(agent);`,
      ].join("\n");
    },
  };
}

/** Read all files in a directory as a map of relative paths to contents. */
async function readDirFiles(dir: string): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir, { recursive: true });
  } catch {
    return {};
  }
  const files: Record<string, string> = {};
  await Promise.all(
    entries.map(async (rel) => {
      const full = path.join(dir, rel);
      const stat = await fs.stat(full);
      if (stat.isFile()) {
        files[rel] = await fs.readFile(full, "utf-8");
      }
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

  // 1. Worker build — bundles agent.ts + worker shim into a single ESM file
  try {
    await build({
      configFile: false,
      root: agent.dir,
      logLevel: "warn",
      plugins: [workerEntryPlugin()],
      build: {
        lib: {
          entry: "virtual:worker-entry",
          formats: ["es"],
          fileName: "worker",
        },
        outDir: buildDir,
        emptyOutDir: true,
        minify: true,
        target: "es2022",
      },
    });
  } catch (err: unknown) {
    throw new BundleError(err instanceof Error ? err.message : String(err));
  }

  // 2. Client build — standard Vite multi-file output (index.html + assets/)
  const skipClient = opts?.skipClient || !agent.clientEntry;

  if (!skipClient) {
    const devMode = isDevMode();
    const devPlugins: Plugin[] = [];
    if (devMode) {
      const monorepoRoot = path.resolve(import.meta.dirname ?? __dirname, "..");
      devPlugins.push(monorepoResolvePlugin(monorepoRoot));
    }

    try {
      await build({
        root: agent.dir,
        base: "./",
        logLevel: "warn",
        plugins: [preact(), tailwindcss(), ...devPlugins],
        ...(devMode && {
          resolve: { dedupe: ["preact", "@preact/signals"] },
        }),
        build: {
          outDir: clientDir,
          emptyOutDir: true,
          minify: true,
          target: "es2022",
        },
      });
    } catch (err: unknown) {
      throw new BundleError(err instanceof Error ? err.message : String(err));
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
