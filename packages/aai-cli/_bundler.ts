// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { agentToolsToSchemas } from "@alexkroman1/aai/isolate";
import { errorMessage } from "@alexkroman1/aai/utils";
import { build } from "vite";
import * as zod from "zod";
import type { AgentEntry } from "./_agent.ts";
import { type CommandResult, ok } from "./_output.ts";

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
  /** Pre-extracted agent config from the built bundle. */
  agentConfig: AgentBundleConfig;
};

/** Output from the directory-based bundler (agent.json + tools/*.ts + hooks/*.ts). */
export type DirectoryBundleOutput = {
  manifest: import("@alexkroman1/aai/isolate").Manifest;
  manifestJson: string;
  toolBundles: Record<string, string>; // toolName -> compiled JS
  hookBundles: Record<string, string>; // hookKey -> compiled JS
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
  // Replace: import { z } from "/app/_zod.mjs"  (handles minified: import{z}from"...")
  transformed = transformed.replace(
    /import\s*\{([^}]+)\}\s*from\s*["'][^"']*_zod[^"']*["'];?\n?/g,
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
    /import\s+(\w+)\s+from\s*["'][^"']*_zod[^"']*["'];?\n?/g,
    "var $1 = __zod__;\n",
  );
  // Replace: import * as z from "/app/_zod.mjs"
  transformed = transformed.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*["'][^"']*_zod[^"']*["'];?\n?/g,
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
 * Throws if extraction fails — the server requires pre-extracted config.
 */
export function extractAgentConfig(workerCode: string): AgentBundleConfig {
  const transformed = transformBundleForEval(workerCode);
  const exports: { default?: Record<string, unknown> } = {};
  try {
    runInNewContext(transformed, { __zod__: zod, __exports__: exports }, { timeout: 5000 });
  } catch (err) {
    throw new BundleError(
      `Failed to extract agent config from bundle: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const agent = exports.default;
  if (!agent || typeof agent !== "object" || typeof agent.name !== "string") {
    throw new BundleError("Agent bundle must export a valid agent definition with a name");
  }

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
  // Zod must be external: the platform server provides a lightweight zod shim
  // in the guest VM's virtual filesystem at /app/_zod.mjs.
  // Everything else is bundled (noExternal: true) so the worker is self-contained.
  try {
    await build({
      root: agent.dir,
      logLevel: "warn",
      build: {
        ssr: path.join(agent.dir, "agent.ts"),
        outDir: buildDir,
        emptyOutDir: true,
        rollupOptions: {
          external: (id) => id === "zod",
          output: {
            entryFileNames: "worker.js",
            paths: { zod: "/app/_zod.mjs" },
          },
        },
      },
      ssr: {
        noExternal: true,
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
    agentConfig,
  };
}

// ── Directory-based bundler (agent.json + tools/*.ts + hooks/*.ts) ───────────

// Hook filenames (kebab-case) -> HookFlags keys (camelCase)
const HOOK_FILENAME_MAP: Record<string, string> = {
  "on-connect": "onConnect",
  "on-disconnect": "onDisconnect",
  "on-user-transcript": "onUserTranscript",
  "on-error": "onError",
};

/**
 * Compile a single TypeScript file with esbuild.
 * Returns the compiled JS as a string.
 */
async function compileFile(filePath: string): Promise<string> {
  const { build: esbuild } = await import("esbuild");
  const result = await esbuild({
    entryPoints: [filePath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no output for ${filePath}`);
  }

  return output.text;
}

/**
 * Bundle an agent directory (agent.json + tools/*.ts + hooks/*.ts)
 * into a manifest + compiled handler code.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { scanAgentDirectory } = await import("./_scanner.ts");
  const { log } = await import("./_ui.ts");

  const manifest = await scanAgentDirectory(cwd);

  log.step(`Bundling ${manifest.name}`);

  const toolBundles: Record<string, string> = {};
  const hookBundles: Record<string, string> = {};

  // Compile tool handlers
  const toolsDir = path.join(cwd, "tools");
  for (const toolName of Object.keys(manifest.tools)) {
    const filePath = path.join(toolsDir, `${toolName}.ts`);
    toolBundles[toolName] = await compileFile(filePath);
  }

  // Compile hook handlers
  const hooksDir = path.join(cwd, "hooks");
  for (const [kebabName, camelName] of Object.entries(HOOK_FILENAME_MAP)) {
    if (manifest.hooks[camelName as keyof typeof manifest.hooks]) {
      const filePath = path.join(hooksDir, `${kebabName}.ts`);
      hookBundles[camelName] = await compileFile(filePath);
    }
  }

  return {
    manifest,
    manifestJson: JSON.stringify(manifest),
    toolBundles,
    hookBundles,
  };
}

/**
 * Build the client SPA using Vite if client.tsx exists.
 * Outputs to .aai/client/ for static serving.
 */
async function buildClient(cwd: string): Promise<void> {
  const clientEntry = path.join(cwd, "client.tsx");
  try {
    await fs.access(clientEntry);
  } catch {
    return; // No client.tsx — skip client build
  }

  const clientDir = path.join(cwd, ".aai", "client");
  await build({
    root: cwd,
    base: "./",
    logLevel: "warn",
    build: {
      outDir: clientDir,
      emptyOutDir: true,
    },
  });
}

type BuildData = {
  manifest: { name: string; tools: string[] };
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  const { log } = await import("./_ui.ts");
  const bundle = await buildAgentBundle(cwd);
  await buildClient(cwd);
  log.success("Build complete");

  const toolNames = Object.keys(bundle.manifest.tools);
  const totalBytes =
    Object.values(bundle.toolBundles).reduce((sum, code) => sum + code.length, 0) +
    Object.values(bundle.hookBundles).reduce((sum, code) => sum + code.length, 0);

  return ok({
    manifest: { name: bundle.manifest.name, tools: toolNames },
    workerBytes: totalBytes,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
