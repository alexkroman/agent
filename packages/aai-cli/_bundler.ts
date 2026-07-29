// Copyright 2025 the AAI authors. MIT license.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "@alexkroman1/aai";
import { agentToolsToSchemas, toAgentConfig } from "@alexkroman1/aai/manifest";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { errorMessage, validateAgentExport } from "./_utils.ts";
import { buildClient } from "./client-bundler.ts";
import { type BuildWorkerOptions, buildWorker } from "./worker-bundler.ts";

export type { BuildWorkerOptions } from "./worker-bundler.ts";
// Re-exported so existing internal importers (_dev-server) keep one entry
// point for bundling; the implementations live in the public *-bundler modules.
export { buildWorker } from "./worker-bundler.ts";

/** Output from the bundler: agentConfig + worker ESM + client files. */
export type DirectoryBundleOutput = {
  /** ESM bundle of agent.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /** Serializable agent config — sent as agentConfig to the server. */
  agentConfig: Record<string, unknown>;
};

/**
 * Bundle an agent directory: build agent.ts into worker ESM + extract config.
 *
 * - agent.ts is the single entry point: `export default agent({...})`
 * - A single Vite build produces the worker ESM (all deps bundled in).
 *   The AgentDef is extracted from that bundle via dynamic import, avoiding a
 *   second build pass.
 */
export async function buildAgentBundle(
  cwd: string,
  opts: BuildWorkerOptions = {},
): Promise<DirectoryBundleOutput> {
  // Single Vite build for the worker (all deps bundled in) + client in
  // parallel. The eval only depends on the worker, so chain it onto the
  // worker build instead of making it wait for the client build too.
  const [[worker, agentDef], clientFiles] = await Promise.all([
    buildWorker(cwd, opts).then(async (code) => [code, await evalWorkerBundle(code, cwd)] as const),
    buildClient(cwd),
  ]);
  log.step(`Bundling ${agentDef.name}`);

  const config = toAgentConfig(agentDef);
  const toolSchemas = agentToolsToSchemas(agentDef.tools ?? {});
  const agentConfig: Record<string, unknown> = { ...config, toolSchemas };

  return { worker, clientFiles, agentConfig };
}

/**
 * Write the worker ESM to a temp file and dynamic-import it, returning
 * the AgentDef default export. All dependencies are bundled in, so the
 * file can be evaluated from any directory.
 *
 * Each call imports a uniquely-named file, and Node's ESM registry never
 * evicts — so every call retains one bundle for the process lifetime. That is
 * fine for one-shot commands (`aai build`/`aai deploy`); long-lived callers
 * must go through `createWorkerEvaluator` to at least dedupe identical
 * builds. Evaluating in a discardable context is not an option: tool
 * `execute` functions from the returned AgentDef are called in-process by the
 * dev runtime, which rules out worker threads, and `node:vm` ESM evaluation
 * is still flagged experimental.
 */
export async function evalWorkerBundle(code: string, cwd: string): Promise<AgentDef> {
  const evalDir = path.join(cwd, ".aai", "eval");
  // Use a unique filename per invocation to avoid Node's ESM import cache.
  const tmpPath = path.join(
    evalDir,
    `agent-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  try {
    await fs.mkdir(evalDir, { recursive: true });
    await fs.writeFile(tmpPath, code);
  } catch (err) {
    // A partial write (ENOSPC) must not leave a stray file behind.
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    // A raw EACCES/ENOSPC here says nothing about what the CLI was doing.
    throw new Error(
      `Failed to write the eval bundle under ${evalDir} — is the project directory writable? ` +
        `(${errorMessage(err)})`,
      { cause: err },
    );
  }
  try {
    // Import errors propagate as-is: they carry the agent code's own failure
    // (syntax error, throwing top-level code), which is the useful message.
    const mod = await import(pathToFileURL(tmpPath).href);
    const agentDef = (mod.default ?? mod) as AgentDef;

    validateAgentExport(agentDef);
    return agentDef;
  } finally {
    await fs.rm(tmpPath).catch(() => {
      /* best-effort cleanup */
    });
  }
}

/**
 * Memoizing wrapper around `evalWorkerBundle` for long-lived callers (the
 * dev server): byte-identical worker code returns the previously evaluated
 * AgentDef without touching the ESM registry. No-op saves and formatter
 * churn are the common watcher events, so this caps the registry leak (see
 * `evalWorkerBundle`) to genuinely-new bundles — the residual one-module-per-
 * distinct-build leak is accepted for the reasons documented there.
 */
export function createWorkerEvaluator(cwd: string): (code: string) => Promise<AgentDef> {
  let lastHash: string | undefined;
  let lastAgentDef: AgentDef | undefined;
  return async (code: string): Promise<AgentDef> => {
    const hash = createHash("sha256").update(code).digest("hex");
    if (lastAgentDef && hash === lastHash) return lastAgentDef;
    const agentDef = await evalWorkerBundle(code, cwd);
    lastHash = hash;
    lastAgentDef = agentDef;
    return agentDef;
  };
}

type BuildData = {
  name: string;
  workerBytes: number;
};

export async function executeBuild(cwd: string): Promise<CommandResult<BuildData>> {
  // `aai build` previews the deploy artifact, so build it exactly like deploy.
  const bundle = await buildAgentBundle(cwd, { minify: true });
  log.success("Build complete");

  return ok({
    name: bundle.agentConfig.name as string,
    workerBytes: bundle.worker.length,
  });
}
