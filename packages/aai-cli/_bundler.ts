// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { type CommandResult, ok } from "./_output.ts";

/** Output from the directory-based bundler (agent.ts single entry point). */
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

// ── Directory-based bundler (agent.ts single entry point) ───────────────────

/**
 * Bundle an agent directory (agent.ts entry point) into a single ESM worker
 * string + agentConfig.
 *
 * 1. Dynamically imports agent.ts to extract metadata for agentConfig
 * 2. Runs esbuild to produce a single ESM bundle
 * 3. Returns { worker, clientFiles, agentConfig }
 */
export async function buildAgentBundle(cwd: string): Promise<DirectoryBundleOutput> {
  const { log } = await import("./_ui.ts");

  const entryPoint = path.join(cwd, "agent.ts");
  try {
    await fs.access(entryPoint);
  } catch (err) {
    throw new Error("Missing agent.ts in agent directory", { cause: err });
  }

  // ── Import agent.ts to extract metadata ────────────────────────────────
  const fileUrl = pathToFileURL(entryPoint).href;
  const mod = await import(`${fileUrl}?t=${Date.now()}`);
  const agent = mod.default;

  if (!agent || typeof agent !== "object") {
    throw new Error("agent.ts must have a default export");
  }

  log.step(`Bundling ${agent.name}`);

  // ── Run esbuild to produce ESM bundle ──────────────────────────────────
  const { build: esbuild } = await import("esbuild");
  const result = await esbuild({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node20",
  });

  const output = result.outputFiles[0];
  if (!output) {
    throw new Error("esbuild produced no output for agent.ts");
  }
  const worker = output.text;

  // ── Derive agentConfig from the imported agent ─────────────────────────
  const tools = agent.tools ?? {};
  const agentConfig: DirectoryBundleOutput["agentConfig"] = {
    name: agent.name,
    systemPrompt: agent.systemPrompt ?? "",
    ...(agent.greeting ? { greeting: agent.greeting } : {}),
    ...(agent.sttPrompt ? { sttPrompt: agent.sttPrompt } : {}),
    ...(agent.maxSteps != null
      ? { maxSteps: typeof agent.maxSteps === "number" ? agent.maxSteps : undefined }
      : {}),
    ...(agent.toolChoice ? { toolChoice: agent.toolChoice } : {}),
    ...(agent.builtinTools ? { builtinTools: agent.builtinTools } : {}),
    toolSchemas: Object.entries(tools).map(([name, tool]) => {
      const t = tool as Record<string, unknown>;
      return {
        name,
        description: (t.description as string) ?? "",
        parameters: (t.parameters as Record<string, unknown>) ?? {},
      };
    }),
    hasState: typeof agent.state === "function",
    hooks: {
      onConnect: typeof agent.onConnect === "function",
      onDisconnect: typeof agent.onDisconnect === "function",
      onError: typeof agent.onError === "function",
      onUserTranscript: typeof agent.onUserTranscript === "function",
      maxStepsIsFn: typeof agent.maxSteps === "function",
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
