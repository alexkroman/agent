// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
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
  /** Single-file HTML page with inlined client JS and CSS. */
  html: string;
  /** Size of the worker bundle in bytes. */
  workerBytes: number;
};

/** Internal helpers exposed for testing. Not part of the public API. */
export const _internals = {
  BundleError,
};

/** Virtual Vite plugin that generates the worker entry point. */
function workerEntryPlugin(agentDir: string): Plugin {
  const id = "virtual:worker-entry";
  const resolved = `\0${id}`;
  return {
    name: "aai-worker-entry",
    enforce: "pre",
    resolveId(source) {
      if (source === id) return resolved;
    },
    load(source) {
      if (source === resolved) {
        const agentPath = path.resolve(agentDir, "agent.ts");
        return [
          `import agent from "${agentPath}";`,
          `import { initWorker } from "@alexkroman1/aai/worker-shim";`,
          `initWorker(agent);`,
        ].join("\n");
      }
    },
  };
}

/** Default Tailwind CSS entry point, generated when the project has no styles.css. */
const DEFAULT_STYLES_CSS = `\
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap");
@import "tailwindcss";
@source "./";
@source "./components/";
@source "./node_modules/@alexkroman1/aai/ui/";

@theme {
  --color-aai-bg: #101010;
  --color-aai-surface: #151515;
  --color-aai-surface-faint: rgba(255, 255, 255, 0.031);
  --color-aai-surface-hover: rgba(255, 255, 255, 0.059);
  --color-aai-border: #282828;
  --color-aai-primary: #fab283;
  --color-aai-text: rgba(255, 255, 255, 0.936);
  --color-aai-text-secondary: rgba(255, 255, 255, 0.618);
  --color-aai-text-muted: rgba(255, 255, 255, 0.284);
  --color-aai-text-dim: rgba(255, 255, 255, 0.422);
  --color-aai-error: #fc533a;
  --color-aai-ring: #9dbefe;
  --color-aai-state-disconnected: rgba(255, 255, 255, 0.422);
  --color-aai-state-connecting: rgba(255, 255, 255, 0.422);
  --color-aai-state-ready: #12c905;
  --color-aai-state-listening: #9dbefe;
  --color-aai-state-thinking: #fcd53a;
  --color-aai-state-speaking: #fc533a;
  --color-aai-state-error: #fc533a;
  --radius-aai: 6px;
  --font-aai: "Inter", system-ui, -apple-system, sans-serif;
  --font-aai-mono: "IBM Plex Mono", monospace;
}

@layer base {
  html, body {
    margin: 0;
    padding: 0;
    background: var(--color-aai-bg);
  }
}

@keyframes aai-bounce {
  0%, 80%, 100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes aai-shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

.tool-shimmer {
  background: linear-gradient(
    90deg,
    var(--color-aai-text) 25%,
    var(--color-aai-text-dim) 50%,
    var(--color-aai-text) 75%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: aai-shimmer 2s ease-in-out infinite;
}
`;

/** Fallback HTML shell generated when no client.tsx exists. */
const INDEX_HTML = `\
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, viewport-fit=cover"
    />
    <title>aai</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="../styles.css" />
  </head>
  <body>
    <main id="app"></main>
    <script type="module" src="../client.tsx"></script>
  </body>
</html>
`;

/**
 * Bundles an agent project into deployable artifacts using Vite.
 *
 * Runs two Vite builds in-process:
 * 1. Worker build — bundles agent.ts into a single worker.js ESM file
 * 2. Client build — bundles client.tsx + Tailwind into a single-file HTML
 *
 * @param agent The discovered agent entry containing paths and configuration.
 * @param opts Optional settings. Set `skipClient` to omit the client bundle.
 * @returns The bundled worker code, single-file HTML, manifest, and byte sizes.
 * @throws {BundleError} If Vite encounters a build error.
 */
export async function bundleAgent(
  agent: AgentEntry,
  opts?: { skipClient?: boolean },
): Promise<BundleOutput> {
  const aaiDir = path.join(agent.dir, ".aai");
  const buildDir = path.join(aaiDir, "build");
  await fs.mkdir(aaiDir, { recursive: true });

  await fs.writeFile(path.join(aaiDir, "index.html"), INDEX_HTML);

  // Generate default Tailwind entry point if missing
  const stylesPath = path.join(agent.dir, "styles.css");
  try {
    await fs.access(stylesPath);
  } catch {
    await fs.writeFile(stylesPath, DEFAULT_STYLES_CSS);
  }

  // 1. Worker build
  try {
    await build({
      configFile: false,
      root: agent.dir,
      logLevel: "warn",
      plugins: [workerEntryPlugin(agent.dir)],
      build: {
        outDir: buildDir,
        emptyOutDir: true,
        minify: true,
        target: "es2022",
        rollupOptions: {
          input: "virtual:worker-entry",
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

  // 2. Client build (if client.tsx exists)
  const skipClient = opts?.skipClient || !agent.clientEntry;
  if (!skipClient) {
    try {
      await build({
        configFile: false,
        root: aaiDir,
        logLevel: "warn",
        plugins: [preact(), tailwindcss(), viteSingleFile()],
        build: {
          outDir: buildDir,
          emptyOutDir: false,
          minify: true,
          target: "es2022",
        },
      });
    } catch (err: unknown) {
      throw new BundleError(err instanceof Error ? err.message : String(err));
    }
  }

  const worker = await fs.readFile(path.join(buildDir, "worker.js"), "utf-8");
  const htmlPath = skipClient ? path.join(aaiDir, "index.html") : path.join(buildDir, "index.html");
  const html = await fs.readFile(htmlPath, "utf-8");

  return {
    worker,
    html,
    workerBytes: Buffer.byteLength(worker),
  };
}
