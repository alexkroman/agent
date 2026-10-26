// Copyright 2025 the AAI authors. MIT license.

import { hash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDef } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { validateAgentExport } from "./_utils.ts";
import { vendorsToOmit } from "./_vendor-openers.ts";
import { buildClient } from "./client-bundler.ts";
import { type BuildWorkerOptions, buildWorker } from "./worker-bundler.ts";

/** Output from the bundler: worker ESM + client files. */
export type DirectoryBundleOutput = {
  /** ESM bundle of agent.ts (tool execute functions + hook handlers). */
  worker: string;
  /** Static client files from Vite build. Empty if no client.tsx. */
  clientFiles: Record<string, string>;
  /**
   * The worker's `__aaiConfig`, read off the runtime-less pre-build that
   * decided which vendors to leave out — the same `toAgentConfig(def)` the
   * full worker exports, so a caller that only needs the config need not
   * import the full worker again. `undefined` when no pre-build ran.
   */
  config?: unknown;
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
  // CONCURRENT, and that is what `withPreservedNodeEnv`'s refcount exists for —
  // read its doc before serializing these. There used to be a THIRD build,
  // sequenced BEFORE the other two: the DevKit compiled a project's `workflows/`
  // per tenant and its output rode the worker as two string exports, because the
  // guest's `bundle/load` takes one ESM string. The replay engine reads the
  // agent's own `workflows` declaration, so there is nothing to compile, nothing
  // to embed, and — the part easy to lose with it — no ordering left between the
  // two that remain. They write to disjoint paths (`.aai/client` and a temp HTML
  // against `.aai/worker-entry.ts`), so the client build is free again.
  const [clientFiles, { worker, config }] = await Promise.all([
    buildClient(cwd),
    buildTrimmedWorker(cwd, opts),
  ]);
  return { worker, clientFiles, ...omitUndefined({ config }) };
}

/**
 * The worker, carrying only the speech SDKs its agent declares.
 *
 * A runtime-bearing build inlines every vendor opener the registry can lazily
 * load (see `_vendor-openers.ts`), so the agent is first built WITHOUT the
 * runtime — ~0.5 s against ~6 s for the full build — and its `__aaiConfig`
 * read back for the STT/TTS kinds it declares. The full build then leaves the
 * other vendors out. A caller that names `omitVendors` itself, or builds no
 * runtime, gets exactly what it asked for.
 */
async function buildTrimmedWorker(
  cwd: string,
  opts: BuildWorkerOptions,
): Promise<{ worker: string; config?: unknown }> {
  if (opts.runtime === false || opts.omitVendors !== undefined) {
    return { worker: await buildWorker(cwd, opts) };
  }
  const config = await evalWorkerConfig(
    await buildWorker(cwd, { ...opts, runtime: false, minify: false }),
  );
  const worker = await buildWorker(cwd, { ...opts, omitVendors: vendorsToOmit(config) });
  return { worker, config };
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
  const mod = await importWorkerModule(code);
  const agentDef = (mod.default ?? mod) as AgentDef;
  validateAgentExport(agentDef);
  return agentDef;
}

/**
 * Import a built worker from a temp file. See {@link evalWorkerBundle}.
 *
 * Exported for the one spec that asserts on a worker's OTHER exports
 * (`_vendor-openers.scenario.test.ts`, on `__aaiCreateRuntime`); a command
 * reaches a worker through the two readers below.
 */
export async function importWorkerModule(code: string): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(path.join(tmpdir(), "aai-worker-"));
  const file = path.join(dir, "worker.mjs");
  try {
    await writeFile(file, code, "utf-8");
    // Import errors propagate as-is: they carry the agent code's own failure
    // (syntax error, throwing top-level code), which is the useful message.
    return await withDedupedWarnings(() => import(pathToFileURL(file).href));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Every `console.warn` line a worker import has printed in this process. */
const warnedOnImport = new Set<string>();

/**
 * Run `fn` with a `console.warn` that prints each distinct line ONCE per
 * process. A command evaluates a worker more than once — `buildTrimmedWorker`
 * imports the runtime-less pre-build for its vendor list, then the build
 * imports the full worker — and each import evaluates the bundle's own SDK
 * copy afresh, so a warning the SDK prints at module evaluation (`withWorkflows`'
 * name clash) came out twice. The SDK cannot dedupe across copies (a warn-once
 * set there is copy-local by the boundary rules); the one process that sees
 * every copy can. Only an exact repeat is dropped, and the original is called
 * for everything else, so nothing printed by a concurrent build is lost.
 */
async function withDedupedWarnings<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = (...args: unknown[]): void => {
    const line = args.map(String).join(" ");
    if (warnedOnImport.has(line)) return;
    warnedOnImport.add(line);
    original.apply(console, args);
  };
  try {
    return await fn();
  } finally {
    console.warn = original;
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
 * Memoizing wrapper around {@link evalWorkerBundle} for long-lived callers
 * (the dev server): byte-identical worker code returns the previously
 * evaluated result without touching the ESM registry. No-op saves and formatter
 * churn are the common watcher events, so this caps the registry leak (see
 * `evalWorkerBundle`) to genuinely-new bundles — the residual one-module-per-
 * distinct-build leak is accepted for the reasons documented there.
 */
export function createWorkerEvaluator(): (code: string) => Promise<AgentDef> {
  // One record rather than a hash/worker pair: a half-updated pair is
  // representable and the guard then needs a `lastWorker &&` conjunct that
  // documents the hazard instead of removing it.
  let last: { hash: string; worker: AgentDef } | undefined;
  return async (code: string): Promise<AgentDef> => {
    const codeHash = hash("sha256", code);
    if (last?.hash === codeHash) return last.worker;
    const worker = await evalWorkerBundle(code);
    last = { hash: codeHash, worker };
    return worker;
  };
}
