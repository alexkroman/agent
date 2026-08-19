// Copyright 2025 the AAI authors. MIT license.

import { hash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { validateAgentExport } from "./_utils.ts";
import { buildClient } from "./client-bundler.ts";
import { type BuildWorkerOptions, buildWorker } from "./worker-bundler.ts";
import { buildWorkflows, type WorkflowBundleOutput } from "./workflow-bundler.ts";

/** Output from the bundler: worker ESM + client files + workflow artifacts. */
export type DirectoryBundleOutput = {
  /** ESM bundle of agent.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /**
   * The project's durable workflows, or undefined when it declares none.
   *
   * Built here rather than in the guest because the transform is per TENANT: the
   * guest image is baked once and serves many agents, so there is no
   * `workflows/` directory in existence when it is built. See
   * `workflow-bundler.ts`.
   */
  workflows?: WorkflowBundleOutput;
};

/**
 * Bundle an agent directory: build agent.ts into worker ESM + client files.
 *
 * agent.ts is the single entry point: `export default agent({...})`. The
 * worker self-describes (it exports `__aaiConfig` — see `worker-bundler.ts`),
 * which is what `evalWorkerConfig` reads back: the platform stores no agent
 * config and evaluates nothing, so every read of one happens here.
 */
export async function buildAgentBundle(
  cwd: string,
  opts: BuildWorkerOptions = {},
): Promise<DirectoryBundleOutput> {
  // The workflow build has to finish FIRST: its output is embedded in the worker
  // as string exports, because the guest's `bundle/load` takes one ESM string.
  // The client build is independent, so it overlaps.
  const [workflows, clientFiles] = await Promise.all([buildWorkflows(cwd), buildClient(cwd)]);
  const worker = await buildWorker(cwd, { ...opts, workflows });
  return { worker, clientFiles, ...omitUndefined({ workflows }) };
}

/**
 * Import the worker ESM from a uniquely named temp file and return the
 * AgentDef default export. A real `file:` URL, not a `data:` URL: deploy
 * bundles ship the SDK runtime, whose CJS interop calls
 * `createRequire(import.meta.url)` — which rejects anything that isn't a
 * file URL or absolute path. (The guest harness imports bundles the same
 * way, for the same reason.) The file is removed after import; the module
 * lives on in memory.
 *
 * Each call imports a unique URL, and Node's ESM registry never evicts — so
 * every call retains one bundle for the process lifetime. That is fine for
 * one-shot commands (`aai build`); long-lived callers must go through
 * `createWorkerEvaluator` to at least dedupe identical builds. Evaluating in
 * a discardable context is not an option: tool `execute` functions from the
 * returned AgentDef are called in-process by the dev runtime, which rules
 * out worker threads, and `node:vm` ESM evaluation is still flagged
 * experimental.
 */
export async function evalWorkerBundle(code: string): Promise<AgentDef> {
  // Delegates rather than repeating the import/unwrap/validate sequence: the
  // two used to be written out twice, so "what counts as a valid worker" had
  // two definitions. The return type stays NARROW — see EvaluatedWorker below
  // for why the workflow strings do not travel with it.
  return (await evalWorkerWithWorkflows(code)).agent;
}

/**
 * The agent plus the compiled workflow surface a worker carries.
 *
 * `evalWorkerBundle` returns only the `AgentDef`, which is all a deploy needs —
 * the guest re-reads the bundle itself. `aai dev` never hands the bundle to a
 * guest, so this is the only path by which the workflow code reaches a running
 * server locally, and dropping it is why `aai dev` served no workflows at first.
 */
export type EvaluatedWorker = {
  agent: AgentDef;
  /** `__aaiWorkflowCode` — the flow bundle, for `workflowEntrypoint`. */
  workflowCode: string | undefined;
  /** `__aaiStepCode` — evaluated to register the project's step functions. */
  stepCode: string | undefined;
};

/**
 * {@link evalWorkerBundle}, keeping the workflow exports the AgentDef cannot
 * carry.
 *
 * A separate function rather than a wider return from `evalWorkerBundle`,
 * because every other caller wants the agent and nothing else — and the two
 * strings are ~76 KB that a deploy path has no use for.
 */
export async function evalWorkerWithWorkflows(code: string): Promise<EvaluatedWorker> {
  const mod = await importWorkerModule(code);
  const agentDef = (mod.default ?? mod) as AgentDef;
  validateAgentExport(agentDef);
  const workflowCode = mod.__aaiWorkflowCode;
  const stepCode = mod.__aaiStepCode;
  return {
    agent: agentDef,
    workflowCode: typeof workflowCode === "string" ? workflowCode : undefined,
    stepCode: typeof stepCode === "string" ? stepCode : undefined,
  };
}

/** Import a built worker from a temp file. See {@link evalWorkerBundle}. */
async function importWorkerModule(code: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(path.join(tmpdir(), "aai-worker-"));
  const file = path.join(dir, "worker.mjs");
  try {
    await writeFile(file, code, "utf-8");
    // Import errors propagate as-is: they carry the agent code's own failure
    // (syntax error, throwing top-level code), which is the useful message.
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The config a built worker describes about itself — its `__aaiConfig`
 * export, generated by `buildWorker`'s wrapper entry (`toAgentConfig(def)`
 * plus the tool schemas).
 *
 * Importing it is also the deploy's SMOKE TEST: a bundle whose top level
 * throws fails here, in the directory that owns it, rather than as a sandbox
 * that never becomes ready after the upload. The platform performs no such
 * check — it evaluates nothing (see `_preflight.ts`).
 *
 * Returns undefined for a bundle built by a CLI old enough not to emit the
 * export; the caller treats that as "nothing to preflight", never an error.
 */
export async function evalWorkerConfig(code: string): Promise<unknown> {
  const mod = await importWorkerModule(code);
  return mod.__aaiConfig;
}

/**
 * Memoizing wrapper around `evalWorkerWithWorkflows` for long-lived callers
 * (the dev server): byte-identical worker code returns the previously
 * evaluated result without touching the ESM registry. No-op saves and formatter
 * churn are the common watcher events, so this caps the registry leak (see
 * `evalWorkerBundle`) to genuinely-new bundles — the residual one-module-per-
 * distinct-build leak is accepted for the reasons documented there.
 *
 * It evaluates the WORKFLOW-carrying variant because its one caller is
 * `aai dev`, which has no guest to re-read the bundle: dropping the two strings
 * here is what left the dev server unable to serve a workflow at all.
 */
export function createWorkerEvaluator(): (code: string) => Promise<EvaluatedWorker> {
  let lastHash: string | undefined;
  let lastWorker: EvaluatedWorker | undefined;
  return async (code: string): Promise<EvaluatedWorker> => {
    const codeHash = hash("sha256", code);
    if (lastWorker && codeHash === lastHash) return lastWorker;
    const worker = await evalWorkerWithWorkflows(code);
    lastHash = codeHash;
    lastWorker = worker;
    return worker;
  };
}
