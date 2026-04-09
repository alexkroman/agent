// Copyright 2025 the AAI authors. MIT license.
/**
 * Dev server for directory-based agents.
 *
 * Scans the agent directory (agent.json + tools/*.ts + hooks/*.ts), builds
 * a runtime, and starts an HTTP+WebSocket server. Watches for file changes
 * and restarts automatically. Optionally runs Vite for client SPA HMR.
 */

import { existsSync, type FSWatcher, readdirSync, watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Manifest } from "@alexkroman1/aai/isolate";
import type { AgentServer } from "@alexkroman1/aai/server";
import { parseEnvFile } from "@alexkroman1/aai/utils";
import { log } from "./_ui.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

type LoadedTool = {
  default: (args: Record<string, unknown>, ctx: unknown) => unknown | Promise<unknown>;
  description?: string;
  parameters?: Record<string, unknown>;
};

type LoadedHook = {
  default: (...args: unknown[]) => void | Promise<void>;
};

// ─── Dynamic importing ──────────────────────────────────────────────────────

const IMPORTABLE_EXTENSIONS = [".ts", ".mjs", ".js"];

/** File extensions to scan for tool/hook modules, in priority order. */
async function scanAndImport<T>(dir: string): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (!existsSync(dir)) return result;

  const files = readdirSync(dir);
  for (const file of files) {
    const ext = IMPORTABLE_EXTENSIONS.find((e) => file.endsWith(e));
    if (!ext) continue;
    const name = path.basename(file, ext);
    if (result.has(name)) continue;
    const filePath = path.join(dir, file);
    // Add cache-busting query to force re-import on restart
    const url = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
    const mod = (await import(url)) as T;
    result.set(name, mod);
  }

  return result;
}

/** Map kebab-case hook filename to camelCase hook key. */
function hookFileNameToKey(fileName: string): string {
  return fileName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ─── Env loading ────────────────────────────────────────────────────────────

async function resolveAgentEnv(root: string): Promise<Record<string, string>> {
  let fileEntries: Record<string, string> = {};
  try {
    const content = await fs.readFile(path.join(root, ".env"), "utf-8");
    fileEntries = parseEnvFile(content);
  } catch {
    // No .env — fine
  }

  const env: Record<string, string> = {};
  for (const [key, fileVal] of Object.entries(fileEntries)) {
    env[key] = process.env[key] ?? fileVal;
  }
  if (!env.ASSEMBLYAI_API_KEY && process.env.ASSEMBLYAI_API_KEY) {
    env.ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
  }
  return env;
}

// ─── Bridge manifest to AgentDef ────────────────────────────────────────────

/**
 * Build an AgentDef-compatible object from a Manifest and loaded tool/hook
 * modules. The runtime expects tools to have `{ description, parameters, execute }`
 * where parameters has `.parse()` and `._def.typeName`.
 */
function buildAgentDef(
  manifest: Manifest,
  tools: Map<string, LoadedTool>,
  hooks: Map<string, LoadedHook>,
): Record<string, unknown> {
  // Build tool definitions compatible with the runtime
  const toolDefs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(manifest.tools)) {
    const loaded = tools.get(name);
    if (!loaded) continue;

    toolDefs[name] = {
      description: schema.description,
      // Create a passthrough wrapper that mimics a Zod schema
      parameters: schema.parameters
        ? { parse: (v: unknown) => v, _def: { typeName: "ZodObject" } }
        : undefined,
      execute: loaded.default,
    };
  }

  // Build hook handlers
  const hookHandlers: Record<string, (...args: unknown[]) => unknown> = {};
  const onConnect = hooks.get("onConnect");
  if (onConnect) hookHandlers.onConnect = onConnect.default;
  const onDisconnect = hooks.get("onDisconnect");
  if (onDisconnect) hookHandlers.onDisconnect = onDisconnect.default;
  const onError = hooks.get("onError");
  if (onError) hookHandlers.onError = onError.default;
  const onUserTranscript = hooks.get("onUserTranscript");
  if (onUserTranscript) hookHandlers.onUserTranscript = onUserTranscript.default;

  return {
    name: manifest.name,
    systemPrompt: manifest.systemPrompt,
    greeting: manifest.greeting,
    sttPrompt: manifest.sttPrompt,
    maxSteps: manifest.maxSteps,
    toolChoice: manifest.toolChoice,
    builtinTools: manifest.builtinTools,
    idleTimeoutMs: manifest.idleTimeoutMs,
    tools: toolDefs,
    ...hookHandlers,
  };
}

// ─── File watching ──────────────────────────────────────────────────────────

/**
 * Watch the agent directory for changes and call `onChange` when detected.
 * Debounces to avoid rapid restarts.
 */
function watchDirectory(dir: string, onChange: () => void): FSWatcher[] {
  const watchers: FSWatcher[] = [];
  const DEBOUNCE_MS = 300;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleChange(filename: string | null) {
    // Ignore .aai build artifacts and node_modules
    if (filename && (filename.startsWith(".aai") || filename.includes("node_modules"))) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      log.info("File change detected, restarting...");
      onChange();
    }, DEBOUNCE_MS);
  }

  // Watch root for agent.json, .env changes
  watchers.push(watch(dir, { persistent: false }, (_event, filename) => handleChange(filename)));

  // Watch tools/ and hooks/ directories
  for (const subdir of ["tools", "hooks"]) {
    const subdirPath = path.join(dir, subdir);
    if (existsSync(subdirPath)) {
      watchers.push(
        watch(subdirPath, { persistent: false }, (_event, filename) => handleChange(filename)),
      );
    }
  }

  return watchers;
}

// ─── Dev server ─────────────────────────────────────────────────────────────

export type DevServerOptions = {
  cwd: string;
  port: number;
};

/**
 * Start the dev server for a directory-based agent.
 *
 * Returns a cleanup function to shut down the server and watchers.
 */
export async function startDevServer(opts: DevServerOptions): Promise<() => Promise<void>> {
  const { cwd, port } = opts;

  const { scanAgentDirectory } = await import("./_scanner.ts");
  const { createRuntime, createServer } = await import("@alexkroman1/aai/server");

  // Check if client.tsx exists for Vite HMR
  const hasClient = existsSync(path.join(cwd, "client.tsx"));

  // Determine ports: if we have a client, Vite gets the main port and
  // the backend gets port+1. Otherwise backend gets the main port.
  const backendPort = hasClient ? port + 1 : port;
  const vitePort = port;

  // Load agent
  const manifest = await scanAgentDirectory(cwd);
  const tools = await scanAndImport<LoadedTool>(path.join(cwd, "tools"));
  const rawHooks = await scanAndImport<LoadedHook>(path.join(cwd, "hooks"));
  const hooks = new Map<string, LoadedHook>();
  for (const [fileName, mod] of rawHooks) {
    hooks.set(hookFileNameToKey(fileName), mod);
  }

  const env = await resolveAgentEnv(cwd);
  const agentDef = buildAgentDef(manifest, tools, hooks);

  // biome-ignore lint/suspicious/noExplicitAny: bridging manifest to runtime AgentDef
  const runtime = createRuntime({ agent: agentDef as any, env });
  const agentServer = createServer({ runtime, name: manifest.name });
  await agentServer.listen(backendPort);

  // Start Vite for client HMR if client.tsx exists
  let viteServer: { close(): Promise<void> } | undefined;
  if (hasClient) {
    const { createServer: createViteServer } = await import("vite");
    const target = `http://localhost:${backendPort}`;
    viteServer = await createViteServer({
      root: cwd,
      server: {
        port: vitePort,
        proxy: {
          "/health": target,
          "/websocket": { target, ws: true },
        },
      },
    });
    await (viteServer as unknown as { listen(): Promise<void> }).listen();
  }

  // Set up file watching for auto-restart
  let restarting = false;
  let currentServer: AgentServer = agentServer;
  let currentVite = viteServer;
  const watchers = watchDirectory(cwd, () => {
    if (restarting) return;
    restarting = true;
    void restart().finally(() => {
      restarting = false;
    });
  });

  async function restart(): Promise<void> {
    // Close current servers
    try {
      await currentServer.close();
    } catch {
      // Ignore close errors during restart
    }

    // Re-scan and reload
    try {
      const newManifest = await scanAgentDirectory(cwd);
      const newTools = await scanAndImport<LoadedTool>(path.join(cwd, "tools"));
      const rawNewHooks = await scanAndImport<LoadedHook>(path.join(cwd, "hooks"));
      const newHooks = new Map<string, LoadedHook>();
      for (const [fileName, mod] of rawNewHooks) {
        newHooks.set(hookFileNameToKey(fileName), mod);
      }

      const newEnv = await resolveAgentEnv(cwd);
      const newAgentDef = buildAgentDef(newManifest, newTools, newHooks);

      // biome-ignore lint/suspicious/noExplicitAny: bridging manifest to runtime AgentDef
      const newRuntime = createRuntime({ agent: newAgentDef as any, env: newEnv });
      const newServer = createServer({ runtime: newRuntime, name: newManifest.name });
      await newServer.listen(backendPort);
      currentServer = newServer;
      log.success("Restarted");
    } catch (err: unknown) {
      log.error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Return cleanup function
  return async () => {
    for (const w of watchers) w.close();
    if (currentVite) {
      await currentVite.close();
      currentVite = undefined;
    }
    await currentServer.close();
  };
}
