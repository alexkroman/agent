// Copyright 2025 the AAI authors. MIT license.

import { hash } from "node:crypto";
import type { AgentDef } from "@alexkroman1/aai";
import { type CommandResult, ok } from "./_output.ts";
import { log } from "./_ui.ts";
import { validateAgentExport } from "./_utils.ts";
import { buildClient } from "./client-bundler.ts";
import { type BuildWorkerOptions, buildWorker } from "./worker-bundler.ts";

/** Output from the bundler: worker ESM + client files. */
export type DirectoryBundleOutput = {
  /** ESM bundle of agent.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
};

/**
 * Bundle an agent directory: build agent.ts into worker ESM + client files.
 *
 * agent.ts is the single entry point: `export default agent({...})`. The
 * worker self-describes (it exports `__aaiConfig` — see `worker-bundler.ts`),
 * so nothing here evaluates the bundle: the server extracts the config inside
 * a guest sandbox at deploy time.
 */
export async function buildAgentBundle(
  cwd: string,
  opts: BuildWorkerOptions = {},
): Promise<DirectoryBundleOutput> {
  const [worker, clientFiles] = await Promise.all([buildWorker(cwd, opts), buildClient(cwd)]);
  return { worker, clientFiles };
}

/**
 * Import the worker ESM via a `data:` URL and return the AgentDef default
 * export. All dependencies are bundled in, so the module needs no filesystem
 * presence to evaluate.
 *
 * Each call imports a uniquely-shaped URL, and Node's ESM registry never
 * evicts — so every call retains one bundle for the process lifetime. That is
 * fine for one-shot commands (`aai build`); long-lived callers must go
 * through `createWorkerEvaluator` to at least dedupe identical builds.
 * Evaluating in a discardable context is not an option: tool `execute`
 * functions from the returned AgentDef are called in-process by the dev
 * runtime, which rules out worker threads, and `node:vm` ESM evaluation is
 * still flagged experimental.
 */
export async function evalWorkerBundle(code: string): Promise<AgentDef> {
  // Import errors propagate as-is: they carry the agent code's own failure
  // (syntax error, throwing top-level code), which is the useful message.
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const agentDef = (mod.default ?? mod) as AgentDef;

  validateAgentExport(agentDef);
  return agentDef;
}

/**
 * Memoizing wrapper around `evalWorkerBundle` for long-lived callers (the
 * dev server): byte-identical worker code returns the previously evaluated
 * AgentDef without touching the ESM registry. No-op saves and formatter
 * churn are the common watcher events, so this caps the registry leak (see
 * `evalWorkerBundle`) to genuinely-new bundles — the residual one-module-per-
 * distinct-build leak is accepted for the reasons documented there.
 */
export function createWorkerEvaluator(): (code: string) => Promise<AgentDef> {
  let lastHash: string | undefined;
  let lastAgentDef: AgentDef | undefined;
  return async (code: string): Promise<AgentDef> => {
    const codeHash = hash("sha256", code);
    if (lastAgentDef && codeHash === lastHash) return lastAgentDef;
    const agentDef = await evalWorkerBundle(code);
    lastHash = codeHash;
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
  // Evaluate locally to validate the agent export and report its name —
  // `aai build` runs the developer's own project code, unlike deploy, which
  // leaves evaluation to the server's guest sandbox.
  const agentDef = await evalWorkerBundle(bundle.worker);
  log.success("Build complete");

  return ok({
    name: agentDef.name,
    workerBytes: bundle.worker.length,
  });
}
