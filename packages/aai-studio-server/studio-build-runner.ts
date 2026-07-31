// Copyright 2026 the AAI authors. MIT license.
/**
 * Selects where studio builds run — never in the server's process.
 *
 * Vite/Rollup over an untrusted workspace tree is the studio's heaviest and
 * least trusted host-side work: in the platform's web container it competes
 * with latency-sensitive voice WebSockets for CPU, and a bundler bug would
 * be an exposure in the process that holds platform credentials. Every
 * build therefore runs the build entry (`studio-build-entry.ts`) in its own
 * process, over the wire protocol in `studio-build-protocol.ts`:
 *
 * - **`modal`** (production; set by modal_deploy.py's image env): the
 *   `studio_build` Modal Function — same image, separate container, no
 *   secrets attached — invoked via the Modal JS SDK.
 * - **`subprocess`** (default — dev, tests, self-hosted): the same entry
 *   spawned as a local child process.
 *
 * There is deliberately **no in-process build path and no fallback between
 * backends**: the isolation is the point, and a silent fallback would
 * reintroduce the interference and the exposure on the first control-plane
 * hiccup with nothing in the logs but a suspiciously fast build. A failed
 * backend is a failed build, loudly.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModalClient } from "modal";
import pTimeout from "p-timeout";
import {
  type StudioBuildRequest,
  StudioBuildResponseSchema,
  type StudioBuildResult,
  type StudioBuildRunner,
} from "./studio-build-protocol.ts";
import { StudioBuildError } from "./studio-errors.ts";

/**
 * Modal app the build function deploys under — the studio's own app (this
 * package's modal_deploy.py), so the build entry's code and its deployment
 * ship together: a changeset touching this package redeploys both.
 */
const DEFAULT_BUILD_APP = "aai-studio-web";
const DEFAULT_BUILD_FUNCTION = "studio_build";
/** Build deadline; generous because a cold Publish runs two Vite passes. */
const DEFAULT_BUILD_TIMEOUT_MS = 180_000;

/** Max stderr bytes attached to a subprocess failure message. */
const MAX_STDERR_BYTES = 16 * 1024;

/**
 * The one operation a backend needs: send the request JSON, return the
 * response JSON. Injectable for tests. `signal` aborts on the build
 * deadline; backends honor it where their transport can (the subprocess is
 * killed; a Modal call is abandoned to its own server-side timeout).
 */
export type InvokeBuildFunction = (requestJson: string, signal: AbortSignal) => Promise<unknown>;

// ── Modal backend ────────────────────────────────────────────────────────────

type RemoteFunction = { remote(args?: unknown[]): Promise<unknown> };

// Memoized deployed-function handle; a lookup failure clears the memo so the
// next build retries (a transient control-plane error must not wedge builds
// for the process lifetime).
let fnPromise: Promise<RemoteFunction> | null = null;
function modalBuildFunction(): Promise<RemoteFunction> {
  fnPromise ??= (async (): Promise<RemoteFunction> => {
    const client = new ModalClient();
    const appName = process.env.STUDIO_BUILD_MODAL_APP ?? DEFAULT_BUILD_APP;
    const name = process.env.STUDIO_BUILD_MODAL_FUNCTION ?? DEFAULT_BUILD_FUNCTION;
    return await client.functions.fromName(appName, name);
  })().catch((err: unknown) => {
    fnPromise = null;
    throw err;
  });
  return fnPromise;
}

const modalInvoke: InvokeBuildFunction = async (requestJson) => {
  const fn = await modalBuildFunction();
  return await fn.remote([requestJson]);
};

// ── Subprocess backend ───────────────────────────────────────────────────────

/**
 * Locate the build entry and the node args to run it with (overridable via
 * STUDIO_BUILD_ENTRY_PATH). Running from source (dev, tests — this module's
 * URL still ends in `.ts`), the entry is the sibling source module and the
 * child needs the same `@dev/source` resolution condition this process runs
 * under. Built, this module is bundled into `dist/index.mjs` while the entry
 * is its own artifact at `dist/studio/studio-build-entry.mjs`.
 */
function entrySpawnSpec(): { nodeArgs: string[]; entryPath: string } {
  const override = process.env.STUDIO_BUILD_ENTRY_PATH;
  if (override) return { nodeArgs: [], entryPath: override };
  if (import.meta.url.endsWith(".ts")) {
    return {
      nodeArgs: ["--conditions=@dev/source"],
      entryPath: path.join(import.meta.dirname, "studio-build-entry.ts"),
    };
  }
  return {
    nodeArgs: [],
    entryPath: path.join(import.meta.dirname, "studio", "studio-build-entry.mjs"),
  };
}

const subprocessInvoke: InvokeBuildFunction = async (requestJson, signal) => {
  const spec = entrySpawnSpec();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aai-studio-build-"));
  try {
    const requestPath = path.join(dir, "request.json");
    const responsePath = path.join(dir, "response.json");
    await fs.writeFile(requestPath, requestJson, "utf-8");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [...spec.nodeArgs, spec.entryPath, requestPath, responsePath],
        // `signal` kills the child on the build deadline — a hung Vite pass
        // must not outlive the request that asked for it.
        { stdio: ["ignore", "ignore", "pipe"], signal },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Studio build entry exited with ${code}: ${stderr.trim()}`));
      });
    });
    return await fs.readFile(responsePath, "utf-8");
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
};

// ── Wire handling shared by both backends ────────────────────────────────────

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Malformed JSON — the schema parse below reports it.
  }
}

/**
 * Wrap an invoke into a runner: serialize the request, bound the call, and
 * rehydrate the response's error classification into the same error types
 * the builders throw — call sites never know where a build ran.
 */
function wireRunner(invoke: InvokeBuildFunction, timeoutMs: number): StudioBuildRunner {
  return async (req: StudioBuildRequest): Promise<StudioBuildResult> => {
    // On timeout the invocation keeps settling on its own; pTimeout keeps
    // observing it, so that can't surface as an unhandled rejection.
    const raw = await pTimeout(invoke(JSON.stringify(req), AbortSignal.timeout(timeoutMs)), {
      milliseconds: timeoutMs,
      message: new Error(`Studio build timed out after ${timeoutMs}ms`),
    });
    const parsed = StudioBuildResponseSchema.safeParse(
      typeof raw === "string" ? safeJsonParse(raw) : undefined,
    );
    if (!parsed.success) throw new Error("Malformed response from the studio build worker");
    const response = parsed.data;
    if (!response.ok) {
      if (response.kind === "build") throw new StudioBuildError(response.error);
      throw new Error(`Studio build worker failed: ${response.error}`);
    }
    return {
      ...(response.worker !== undefined && { worker: response.worker }),
      ...(response.clientFiles !== undefined && { clientFiles: response.clientFiles }),
    };
  };
}

function buildTimeoutMs(): number {
  const value = Number(process.env.STUDIO_BUILD_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BUILD_TIMEOUT_MS;
}

export type BuildRunnerOptions = { invoke?: InvokeBuildFunction; timeoutMs?: number };

/** Runner backed by the deployed `studio_build` Modal Function. */
export function createModalBuildRunner(opts: BuildRunnerOptions = {}): StudioBuildRunner {
  return wireRunner(opts.invoke ?? modalInvoke, opts.timeoutMs ?? buildTimeoutMs());
}

/** Runner spawning the build entry as a local child process. */
export function createSubprocessBuildRunner(opts: BuildRunnerOptions = {}): StudioBuildRunner {
  return wireRunner(opts.invoke ?? subprocessInvoke, opts.timeoutMs ?? buildTimeoutMs());
}

const runnerMemo = new Map<string, StudioBuildRunner>();

/**
 * The env-selected build runner: `STUDIO_BUILD_BACKEND=modal` → the Modal
 * build worker; unset/`subprocess` → a local build subprocess. An unknown
 * value throws on the first build rather than guessing — a misconfigured
 * backend must be loud, never a quiet different build path.
 */
export function resolveStudioBuildRunner(
  env: Record<string, string | undefined> = process.env,
): StudioBuildRunner {
  const backend = env.STUDIO_BUILD_BACKEND ?? "subprocess";
  const backends: Record<string, () => StudioBuildRunner> = {
    modal: createModalBuildRunner,
    subprocess: createSubprocessBuildRunner,
  };
  const create = backends[backend];
  if (!create) {
    throw new Error(
      `Unknown STUDIO_BUILD_BACKEND: "${backend}" (expected "subprocess" or "modal")`,
    );
  }
  let runner = runnerMemo.get(backend);
  if (!runner) {
    runner = create();
    runnerMemo.set(backend, runner);
  }
  return runner;
}
