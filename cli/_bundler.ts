// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { build, type Rollup } from "vite";
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
  /** Size of the worker bundle in bytes. */
  workerBytes: number;
};

/** Internal helpers exposed for testing. Not part of the public API. */
export const _internals = {
  BundleError,
};

/** Extract a file map from a Vite/Rollup build result. */
function extractFiles(result: Rollup.RollupOutput | Rollup.RollupOutput[]): Record<string, string> {
  const outputs = Array.isArray(result) ? result : [result];
  const files: Record<string, string> = {};
  for (const output of outputs) {
    for (const chunk of output.output) {
      if (chunk.type === "chunk") {
        files[chunk.fileName] = chunk.code;
      } else {
        files[chunk.fileName] =
          typeof chunk.source === "string" ? chunk.source : new TextDecoder().decode(chunk.source);
      }
    }
  }
  return files;
}

/**
 * Bundles an agent project into deployable artifacts using Vite.
 *
 * Runs two Vite builds in-process:
 * 1. Worker build — generates a real entry file in .aai/ that imports
 *    agent.ts and wires it to the platform shim, then bundles into worker.js
 * 2. Client build — bundles client.tsx + Tailwind into standard multi-file
 *    output (index.html + assets/)
 *
 * @param agent The discovered agent entry containing paths and configuration.
 * @param opts Optional settings. Set `skipClient` to omit the client bundle.
 * @returns The bundled worker code, client files map, and byte sizes.
 * @throws {BundleError} If Vite encounters a build error.
 */
export async function bundleAgent(
  agent: AgentEntry,
  opts?: { skipClient?: boolean },
): Promise<BundleOutput> {
  const aaiDir = path.join(agent.dir, ".aai");
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
  let workerResult: Rollup.RollupOutput | Rollup.RollupOutput[];
  try {
    workerResult = (await build({
      configFile: false,
      root: agent.dir,
      logLevel: "warn",
      build: {
        write: false,
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
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  } catch (err: unknown) {
    throw new BundleError(err instanceof Error ? err.message : String(err));
  }

  const workerFiles = extractFiles(workerResult);
  const worker = workerFiles["worker.js"] ?? "";

  // 2. Client build — standard Vite multi-file output (index.html + assets/)
  const skipClient = opts?.skipClient || !agent.clientEntry;
  let clientFiles: Record<string, string> = {};

  if (!skipClient) {
    let clientResult: Rollup.RollupOutput | Rollup.RollupOutput[];
    try {
      clientResult = (await build({
        root: agent.dir,
        base: "./",
        logLevel: "warn",
        plugins: [preact(), tailwindcss()],
        build: {
          write: false,
          minify: true,
          target: "es2022",
        },
      })) as Rollup.RollupOutput | Rollup.RollupOutput[];
    } catch (err: unknown) {
      throw new BundleError(err instanceof Error ? err.message : String(err));
    }

    clientFiles = extractFiles(clientResult);
  }

  return {
    worker,
    clientFiles,
    workerBytes: Buffer.byteLength(worker),
  };
}
