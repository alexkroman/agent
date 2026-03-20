// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";
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

/** Internal helpers exposed for testing. Not part of the public API. */
export const _internals = {
  BundleError,
};

/** Recursively read all files in a directory as a map of relative paths to contents. */
async function readDirRecursive(dir: string, base = dir): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return files;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full);
    const entry = { name, isDirectory: () => stat.isDirectory() };
    if (entry.isDirectory()) {
      Object.assign(files, await readDirRecursive(full, base));
    } else {
      const rel = path.relative(base, full);
      files[rel] = await fs.readFile(full, "utf-8");
    }
  }
  return files;
}

/** Walk up from a resolved entry to find the package root by matching package.json name. */
async function findPackageDir(resolvedEntry: string, packageName: string): Promise<string> {
  let dir = path.dirname(resolvedEntry);
  while (dir !== path.dirname(dir)) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf-8"));
      if (pkg.name === packageName) return dir;
    } catch {}
    dir = path.dirname(dir);
  }
  return path.dirname(resolvedEntry);
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
  await fs.mkdir(aaiDir, { recursive: true });

  // Generate the worker entry file — a real file in .aai/ that the user
  // can inspect for debugging, like Next.js generates files in .next/.
  const workerEntry = path.join(aaiDir, "_worker_entry.ts");
  await fs.writeFile(
    workerEntry,
    [
      `import agent from "../agent.ts";`,
      `import { initWorker } from "@alexkroman1/aai/worker-shim";`,
      `initWorker(agent);`,
    ].join("\n"),
  );

  // 1. Worker build — bundles the entry into a single ESM file
  try {
    await build({
      configFile: false,
      root: agent.dir,
      logLevel: "warn",
      build: {
        outDir: buildDir,
        emptyOutDir: true,
        minify: true,
        target: "es2022",
        rollupOptions: {
          input: workerEntry,
          output: {
            format: "es",
            entryFileNames: "worker.js",
            inlineDynamicImports: true,
          },
        },
      },
    });
  } catch (err: unknown) {
    throw new BundleError(err instanceof Error ? err.message : String(err));
  }

  // 2. Client build — standard Vite multi-file output (index.html + assets/)
  const skipClient = opts?.skipClient || !agent.clientEntry;

  if (!skipClient) {
    const _require = createRequire(import.meta.url);
    const preactDir = path.dirname(_require.resolve("preact/package.json"));
    const preactSignalsDir = await findPackageDir(
      _require.resolve("@preact/signals"),
      "@preact/signals",
    );
    try {
      await build({
        root: agent.dir,
        base: "./",
        logLevel: "warn",
        plugins: [preact(), tailwindcss()],
        resolve: {
          alias: {
            preact: preactDir,
            "@preact/signals": preactSignalsDir,
          },
        },
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
  const clientFiles = await readDirRecursive(clientDir);

  return {
    worker,
    clientFiles,
    clientDir,
    workerBytes: Buffer.byteLength(worker),
  };
}
