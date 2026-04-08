// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { agentToolsToSchemas } from "@alexkroman1/aai/isolate";
import { errorMessage } from "@alexkroman1/aai/utils";
import { build } from "vite";
import { z } from "zod";
import type { AgentEntry } from "./_agent.ts";

export class BundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleError";
  }
}

/** Config shape extracted from the agent bundle at build time.
 *  Matches IsolateConfig from aai-server/rpc-schemas.ts. */
export type AgentBundleConfig = {
  name: string;
  systemPrompt: string;
  greeting?: string;
  sttPrompt?: string;
  maxSteps?: number;
  toolChoice?: "auto" | "required";
  builtinTools?: string[];
  toolSchemas: { name: string; description: string; parameters: Record<string, unknown> }[];
  hasState: boolean;
  hooks: {
    onConnect: boolean;
    onDisconnect: boolean;
    onError: boolean;
    onUserTranscript: boolean;
    maxStepsIsFn: boolean;
  };
};

export type BundleOutput = {
  slug: string;
  worker: string;
  clientFiles: Record<string, string>;
  clientDir: string;
  workerBytes: number;
  /** Pre-extracted agent config. Undefined if extraction failed (server falls back to isolate). */
  agentConfig?: AgentBundleConfig;
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
 * Transform an ESM worker bundle into a script evaluable by `node:vm`.
 *
 * Handles the standard Vite SSR + Rollup output where zod is externalized
 * to `/app/_zod.mjs`. Replaces ESM import/export syntax with CJS-compatible
 * patterns that work in `runInNewContext`.
 *
 * @internal Exported for testing only.
 */
export function transformBundleForEval(code: string): string {
  let transformed = code;
  // Replace: import { z } from "/app/_zod.mjs"
  transformed = transformed.replace(
    /import\s+\{([^}]+)\}\s+from\s+["'][^"']*_zod[^"']*["'];?\n?/g,
    (_, imports: string) => {
      const bindings = imports.split(",").map((s: string) => s.trim());
      return `${bindings
        .map((b: string) => {
          const aliasMatch = b.match(/(\w+)\s+as\s+(\w+)/);
          if (aliasMatch) return `var ${aliasMatch[2]} = __zod__["${aliasMatch[1]}"];`;
          return `var ${b} = __zod__["${b}"];`;
        })
        .join("\n")}\n`;
    },
  );
  // Replace: import z from "/app/_zod.mjs"
  transformed = transformed.replace(
    /import\s+(\w+)\s+from\s+["'][^"']*_zod[^"']*["'];?\n?/g,
    "var $1 = __zod__;\n",
  );
  // Replace: import * as z from "/app/_zod.mjs"
  transformed = transformed.replace(
    /import\s+\*\s+as\s+(\w+)\s+from\s+["'][^"']*_zod[^"']*["'];?\n?/g,
    "var $1 = __zod__;\n",
  );
  // Replace: export default X  (anywhere in the file)
  transformed = transformed.replace(/export\s+default\s+/, "__exports__.default = ");
  // Replace: export { X as default }
  transformed = transformed.replace(
    /export\s*\{\s*(\w+)\s+as\s+default\s*\};?/g,
    "__exports__.default = $1;",
  );
  return transformed;
}

/**
 * Extract agent config from a built worker bundle at build time.
 *
 * Evaluates the bundle in `node:vm` with real zod provided, then extracts
 * the serializable config (same shape as IsolateConfig from rpc-schemas.ts).
 *
 * Returns `undefined` if extraction fails — the server will fall back to
 * extracting config from the V8 isolate at boot time.
 */
export function extractAgentConfig(workerCode: string): AgentBundleConfig | undefined {
  try {
    const transformed = transformBundleForEval(workerCode);
    const exports: { default?: Record<string, unknown> } = {};
    runInNewContext(transformed, { __zod__: z, __exports__: exports }, { timeout: 5000 });

    const agent = exports.default;
    if (!agent || typeof agent !== "object" || typeof agent.name !== "string") return;

    // Extract tool schemas using the SDK's agentToolsToSchemas (real Zod → JSON Schema)
    const tools = (agent.tools ?? {}) as Record<
      string,
      { description: string; parameters?: unknown }
    >;
    let toolSchemas: AgentBundleConfig["toolSchemas"];
    try {
      toolSchemas = agentToolsToSchemas(
        tools as Parameters<typeof agentToolsToSchemas>[0],
      ) as AgentBundleConfig["toolSchemas"];
    } catch {
      // If Zod schema conversion fails, fall back to manual extraction
      toolSchemas = Object.entries(tools).map(([name, def]) => ({
        name,
        description: def.description ?? "",
        parameters: { type: "object", properties: {} },
      }));
    }

    const config: AgentBundleConfig = {
      name: agent.name as string,
      systemPrompt: agent.systemPrompt as string,
      toolSchemas,
      hasState: typeof agent.state === "function",
      hooks: {
        onConnect: typeof agent.onConnect === "function",
        onDisconnect: typeof agent.onDisconnect === "function",
        onError: typeof agent.onError === "function",
        onUserTranscript: typeof agent.onUserTranscript === "function",
        maxStepsIsFn: typeof agent.maxSteps === "function",
      },
    };
    if (typeof agent.greeting === "string") config.greeting = agent.greeting;
    if (agent.sttPrompt !== undefined) config.sttPrompt = agent.sttPrompt as string;
    if (typeof agent.maxSteps !== "function" && agent.maxSteps !== undefined)
      config.maxSteps = agent.maxSteps as number;
    if (agent.toolChoice !== undefined) config.toolChoice = agent.toolChoice as "auto" | "required";
    if (agent.builtinTools) config.builtinTools = [...(agent.builtinTools as string[])];
    return config;
  } catch {
    // Extraction is best-effort; server falls back to isolate-based extraction
  }
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
  // Zod must be external: its JIT compiler uses Function() which is blocked
  // in secure-exec isolates. The platform server provides a safe zod build
  // in the isolate's virtual filesystem at /app/_zod.mjs.
  try {
    await build({
      root: agent.dir,
      logLevel: "warn",
      build: {
        ssr: path.join(agent.dir, "agent.ts"),
        outDir: buildDir,
        emptyOutDir: true,
        rollupOptions: {
          external: ["zod"],
          output: {
            entryFileNames: "worker.js",
            paths: { zod: "/app/_zod.mjs" },
          },
        },
      },
      ssr: {
        external: ["zod"],
      },
    });
  } catch (err: unknown) {
    throw new BundleError(errorMessage(err), { cause: err });
  }

  // 2. Client — standard Vite build
  if (!opts?.skipClient && agent.clientEntry) {
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

  const agentConfig = extractAgentConfig(worker);

  return {
    slug: agent.slug,
    worker,
    clientFiles,
    clientDir,
    workerBytes: Buffer.byteLength(worker),
    ...(agentConfig ? { agentConfig } : {}),
  };
}

export async function buildAgentBundle(cwd: string): Promise<BundleOutput> {
  const { loadAgent } = await import("./_agent.ts");
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
