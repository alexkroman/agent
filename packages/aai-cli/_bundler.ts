// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@alexkroman1/aai/utils";
import { build, createServer as createViteServer, type ViteDevServer } from "vite";
import type { AgentEntry } from "./_discover.ts";

/**
 * Error thrown when bundling fails.
 *
 * @param message Human-readable error message (typically formatted build output).
 */
export class BundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleError";
  }
}

/** Output artifacts produced by {@link bundleAgent}. */
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

/** File extensions that are safe to read as UTF-8 text. */
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

/** Read all files in a directory as a map of relative paths to contents. */
async function readDirFiles(dir: string): Promise<Record<string, string>> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
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
          // Binary files are base64-encoded to preserve data through JSON transport
          const buf = await fs.readFile(full);
          files[rel] = `base64:${buf.toString("base64")}`;
        }
      }),
  );
  return files;
}

/**
 * Bundles an agent project into deployable artifacts using Vite.
 *
 * Uses the project's `vite.config.ts` (which includes the aai plugin) for
 * the client build. The aai plugin's `buildStart` hook handles the worker
 * build automatically.
 *
 * Writes all output to `.aai/` on disk:
 * - `.aai/build/worker.js` — the platform worker bundle
 * - `.aai/client/` — standard Vite multi-file output (index.html + assets/)
 */
export async function bundleAgent(
  agent: AgentEntry,
  opts?: { skipClient?: boolean },
): Promise<BundleOutput> {
  const aaiDir = path.join(agent.dir, ".aai");
  const buildDir = path.join(aaiDir, "build");
  const clientDir = path.join(aaiDir, "client");

  // 1. Worker build — bundles agent.ts into a single ESM file for the secure-exec isolate
  try {
    await build({
      configFile: false,
      root: agent.dir,
      logLevel: "warn",
      build: {
        lib: {
          entry: path.join(agent.dir, "agent.ts"),
          formats: ["es"],
          fileName: () => "worker.js",
        },
        outDir: buildDir,
        emptyOutDir: true,
        minify: true,
        target: "es2022",
      },
    });
  } catch (err: unknown) {
    throw new BundleError(errorMessage(err), { cause: err });
  }

  // 2. Client build — uses vite.config.ts (with aai plugin) for Preact + Tailwind.
  //    The aai plugin's buildStart hook would also run the worker build, but we
  //    already did that above, so set the env flag to skip the nested build.
  const skipClient = opts?.skipClient ?? !agent.clientEntry;

  if (!skipClient) {
    process.env.__AAI_WORKER_BUILD = "1";
    try {
      await build({
        root: agent.dir,
        logLevel: "warn",
        build: {
          outDir: clientDir,
          emptyOutDir: true,
          minify: true,
          target: "es2022",
        },
      });
    } catch (err: unknown) {
      throw new BundleError(errorMessage(err), { cause: err });
    } finally {
      delete process.env.__AAI_WORKER_BUILD;
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

/**
 * Discover the agent entry and bundle both worker and client.
 *
 * Shared by `aai build`, `aai dev`, and `aai deploy`.
 */
export async function buildAgentBundle(cwd: string): Promise<BundleOutput> {
  const { loadAgent } = await import("./_discover.ts");
  const { consola } = await import("./_ui.ts");

  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  consola.start(`Bundle ${agent.slug}`);
  let bundle: BundleOutput;
  try {
    bundle = await bundleAgent(agent);
  } catch (err: unknown) {
    if (err instanceof BundleError) {
      throw new Error(`Bundle failed: ${err.message}`, { cause: err });
    }
    throw err;
  }

  const kb = (bundle.workerBytes / 1024).toFixed(1);
  const clientCount = Object.keys(bundle.clientFiles).length;
  consola.log(`worker: ${kb} KB, client: ${clientCount} file(s)`);

  return bundle;
}

/** Bundle the agent and report success. Used by `aai build`. */
export async function runBuildCommand(cwd: string): Promise<void> {
  const { consola } = await import("./_ui.ts");
  await buildAgentBundle(cwd);
  consola.success("Build ok");
}

/**
 * Create a Vite dev server for client HMR during development.
 *
 * Uses the project's `vite.config.ts` (with aai plugin) to create a
 * single-process server where the agent runtime runs as Vite middleware.
 * No separate backend process or proxy needed.
 */
export async function createClientDevServer(
  agentDir: string,
  port: number,
): Promise<ViteDevServer> {
  const vite = await createViteServer({
    root: agentDir,
    server: {
      port,
      strictPort: true,
    },
  });
  return vite;
}
