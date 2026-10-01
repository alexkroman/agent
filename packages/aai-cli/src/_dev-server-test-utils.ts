// Copyright 2025 the AAI authors. MIT license.
/**
 * The shared seam harness for the `_dev-server` specs: a fixture project and a
 * full set of fake {@link DevServerSeams}.
 *
 * No module mocks. `startDevServer` reaches the watcher, the backend, the
 * login key, the schema DDL, the port probe, Vite and the terminal through its
 * seams, so a spec hands these fakes in and everything else — the bundler
 * build, `.env` resolution from the fixture, agent validation, the real
 * journal, the credential fallback — is the shipped code path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeOptions } from "@alexkroman1/aai-runtime";
import { vi } from "vitest";
import type {
  DevBackend,
  DevRuntime,
  DevServeOptions,
  DevServerSeams,
  DevVite,
} from "./_dev-server.ts";
import type { DevWatchFn } from "./_dev-watch.ts";
import { createFakeUi, linkSdkNodeModules } from "./_test-utils.ts";

// ─── Fixture project ─────────────────────────────────────────────────────────

/**
 * Write a minimal `agent.ts` in `dir`, with the SDK resolvable from it.
 *
 * `linkSdkNodeModules` is the version of the link that only forgives an EEXIST
 * of its own link, so a real failure names the link rather than surfacing as a
 * module-resolution error several layers away.
 */
export async function writeAgentTs(dir: string, name = "test-agent"): Promise<void> {
  await linkSdkNodeModules(dir);
  await fs.writeFile(
    path.join(dir, "agent.ts"),
    `export default { name: "${name}", tools: {} };\n`,
  );
}

/**
 * {@link writeAgentTs} plus a `.env` — the REAL `resolveServerEnv` reads it, so
 * a spec states the env by writing the file rather than by mocking the read.
 */
export async function writeProject(
  dir: string,
  env: Record<string, string> = { ASSEMBLYAI_API_KEY: "test-key" },
): Promise<void> {
  await writeAgentTs(dir);
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  await fs.writeFile(path.join(dir, ".env"), body);
}

// ─── Fake seams ──────────────────────────────────────────────────────────────

/** One `serve` call: what the build asked for, with the server options resolved. */
export type ServedBuild = {
  runtimeOptions: RuntimeOptions;
  serverOptions: DevServeOptions;
};

/**
 * A recording fake for every {@link DevServerSeams} member.
 *
 * `serve` records each build's runtime options and the server options built
 * over {@link FAKE_RUNTIME}, and returns one shared backend, so `listen` and
 * `close` count across rebuilds. The watcher captures its `ignored` matcher
 * and its listeners so a spec can fire a synthetic change.
 */
export function makeDevSeams() {
  const ui = createFakeUi();
  const listen = vi.fn<DevBackend["listen"]>(async () => undefined);
  const close = vi.fn<DevBackend["close"]>(async () => undefined);
  const served: ServedBuild[] = [];
  const serve = vi.fn<DevServerSeams["serve"]>((runtimeOptions, serverOptions) => {
    served.push({ runtimeOptions, serverOptions: serverOptions(FAKE_RUNTIME) });
    return { listen, close };
  });
  const listeners = new Map<string, (arg?: unknown) => void>();
  const watcher = {
    dir: undefined as string | undefined,
    ignored: undefined as ((filePath: string) => boolean) | undefined,
    close: vi.fn(async () => undefined),
  };
  const watch = vi.fn<DevWatchFn>((dir, options) => {
    watcher.dir = dir;
    watcher.ignored = options.ignored;
    return {
      on(event: string, listener: (arg?: unknown) => void) {
        listeners.set(event, listener);
      },
      close: watcher.close,
    };
  });
  const vite = {
    listen: vi.fn(async (): Promise<unknown> => undefined),
    close: vi.fn(async () => undefined),
    httpServer: null,
  } satisfies DevVite;
  const seams = {
    ui,
    watch,
    serve,
    ensureApiKey: vi.fn<DevServerSeams["ensureApiKey"]>(async () => "test-api-key"),
    ensureSessionStateSchema: vi.fn<DevServerSeams["ensureSessionStateSchema"]>(async () => true),
    ensureWorkflowJournalSchema: vi.fn<DevServerSeams["ensureWorkflowJournalSchema"]>(
      async () => true,
    ),
    // Deterministic: the first candidate, as a free port range would answer.
    getPort: vi.fn<DevServerSeams["getPort"]>(
      async (candidates) => candidates[Symbol.iterator]().next().value ?? 0,
    ),
    createViteServer: vi.fn<DevServerSeams["createViteServer"]>(async () => vite),
  } satisfies DevServerSeams;
  return {
    seams,
    ui,
    served,
    /** The most recent build's options. */
    lastBuild: (): ServedBuild | undefined => served.at(-1),
    listen,
    close,
    serve,
    watch,
    watcher,
    vite,
    /** Fire a synthetic watcher change event, as chokidar's "all" does. */
    fireChange: () => listeners.get("all")?.(),
    /** Whether the watcher is up with its change listener attached. */
    watching: () => listeners.has("all"),
  };
}

/** The runtime a fake `serve` builds its server options over. */
export const FAKE_RUNTIME: DevRuntime = {};
