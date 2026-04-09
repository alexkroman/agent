// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { type CommandResult, ok } from "./_output.ts";

/** Output from the directory-based bundler (agent.json + tools/*.ts + hooks/*.ts). */
export type DirectoryBundleOutput = {
  /** Single ESM bundle exporting an AgentDef (tools + hooks compiled in). */
  worker: string;
  /** Static client files from Vite build (path -> content). Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /** Pre-extracted agent config for the server (derived from manifest). */
  agentConfig: {
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
};

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
 *
 * @param format - "esm" for standalone use, "cjs" for embedding inside a worker wrapper.
 */
async function compileFile(filePath: string, format: "esm" | "cjs" = "cjs"): Promise<string> {
  const { build: esbuild } = await import("esbuild");
  const result = await esbuild({
    entryPoints: [filePath],
    bundle: true,
    write: false,
    format,
    platform: "node",
    target: "node20",
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no output for ${filePath}`);
  }

  return output.text;
}

/** Sanitize a name for use as a JS identifier (replace non-alphanumeric with _). */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Bundle an agent directory (agent.json + tools/*.ts + hooks/*.ts)
 * into a single ESM worker string + agentConfig.
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  log.step(`Bundling ${manifest.name}`);

  // ── Compile tools (CJS format for embedding) ──────────────────────────
  const toolWrappers: string[] = [];
  const toolsDir = path.join(cwd, "tools");
  for (const toolName of Object.keys(manifest.tools)) {
    const filePath = path.join(toolsDir, `${toolName}.ts`);
    const cjsCode = await compileFile(filePath, "cjs");
    const varName = `__tool_${safeName(toolName)}`;
    toolWrappers.push(
      `const ${varName} = (() => { const module = { exports: {} }; const exports = module.exports;\n${cjsCode}\nreturn module.exports; })();`,
    );
  }

  // ── Compile hooks (CJS format for embedding) ──────────────────────────
  const hookWrappers: string[] = [];
  const hookEntries: string[] = [];
  const hooksDir = path.join(cwd, "hooks");
  for (const [kebabName, camelName] of Object.entries(HOOK_FILENAME_MAP)) {
    if (manifest.hooks[camelName as keyof typeof manifest.hooks]) {
      const filePath = path.join(hooksDir, `${kebabName}.ts`);
      const cjsCode = await compileFile(filePath, "cjs");
      const varName = `__hook_${safeName(camelName)}`;
      hookWrappers.push(
        `const ${varName} = (() => { const module = { exports: {} }; const exports = module.exports;\n${cjsCode}\nreturn module.exports; })();`,
      );
      hookEntries.push(`${camelName}: ${varName}.default`);
    }
  }

  // ── Assemble tool entries for the default export ──────────────────────
  const toolEntries = Object.entries(manifest.tools)
    .map(([name, tool]) => {
      const varName = `__tool_${safeName(name)}`;
      const paramLine = tool.parameters
        ? `parameters: { parse: (v) => v, _def: { typeName: "ZodObject" } },`
        : "";
      return `    ${JSON.stringify(name)}: {\n      description: ${JSON.stringify(tool.description)},\n      ${paramLine}\n      execute: ${varName}.default,\n    }`;
    })
    .join(",\n");

  // ── Build the single ESM worker string ────────────────────────────────
  const worker = [
    ...toolWrappers,
    ...hookWrappers,
    "export default {",
    `  name: ${JSON.stringify(manifest.name)},`,
    `  systemPrompt: ${JSON.stringify(manifest.systemPrompt)},`,
    `  greeting: ${JSON.stringify(manifest.greeting)},`,
    ...(manifest.sttPrompt ? [`  sttPrompt: ${JSON.stringify(manifest.sttPrompt)},`] : []),
    `  maxSteps: ${manifest.maxSteps},`,
    `  tools: {\n${toolEntries}\n  },`,
    ...(hookEntries.length > 0 ? hookEntries.map((e) => `  ${e},`) : []),
    "};",
  ].join("\n");

  // ── Derive agentConfig ────────────────────────────────────────────────
  const agentConfig: DirectoryBundleOutput["agentConfig"] = {
    name: manifest.name,
    systemPrompt: manifest.systemPrompt,
    greeting: manifest.greeting,
    ...(manifest.sttPrompt ? { sttPrompt: manifest.sttPrompt } : {}),
    maxSteps: manifest.maxSteps,
    toolChoice: manifest.toolChoice,
    builtinTools: manifest.builtinTools,
    toolSchemas: Object.entries(manifest.tools).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters ?? {},
    })),
    hasState: false,
    hooks: {
      ...manifest.hooks,
      maxStepsIsFn: false,
    },
  };

  return { worker, clientFiles: {}, agentConfig };
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

  return ok({
    manifest: {
      name: bundle.agentConfig.name,
      tools: bundle.agentConfig.toolSchemas.map((t) => t.name),
    },
    workerBytes: bundle.worker.length,
  });
}

export async function runBuildCommand(cwd: string): Promise<void> {
  await executeBuild(cwd);
}
