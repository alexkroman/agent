// Copyright 2025 the AAI authors. MIT license.
//
// Dev server for directory-based agents: imports agent.ts directly, builds a
// runtime, starts an HTTP+WebSocket server, and watches for file changes to
// restart automatically. Optionally runs Vite for client SPA HMR.

import { existsSync, type FSWatcher, watch } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentDef, errorMessage } from "@alexkroman1/aai";
import type { AgentServer } from "@alexkroman1/aai/runtime";
import pDebounce from "p-debounce";
import { ensureApiKey } from "./_config.ts";
import { fallbackHtmlPlugin } from "./_default-html.ts";
import { resolveServerEnv } from "./_server-common.ts";
import { log } from "./_ui.ts";
import { validateAgentExport } from "./_utils.ts";

const RESTART_DEBOUNCE_MS = 300;

async function resolveAgentEnv(root: string): Promise<Record<string, string>> {
  const env = await resolveServerEnv(root);
  env.ASSEMBLYAI_API_KEY ??= await ensureApiKey();
  return env;
}

// biome-ignore lint/suspicious/noExplicitAny: agent state type varies per agent
async function loadAgentDef(cwd: string): Promise<AgentDef<any>> {
  // Cache-bust query so hot reloads pick up the latest agent.ts.
  const agentUrl = `${pathToFileURL(path.join(cwd, "agent.ts")).href}?t=${Date.now()}`;
  const mod = await import(agentUrl);
  validateAgentExport(mod.default);
  return mod.default;
}

function watchDirectory(dir: string, onChange: () => void): FSWatcher[] {
  const debounced = pDebounce(() => {
    log.info("File change detected, restarting...");
    onChange();
  }, RESTART_DEBOUNCE_MS);

  return [
    watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && (filename.startsWith(".aai") || filename.includes("node_modules"))) return;
      void debounced();
    }),
  ];
}

export type DevServerOptions = {
  cwd: string;
  port: number;
};

export async function startDevServer(opts: DevServerOptions): Promise<() => Promise<void>> {
  const { cwd, port } = opts;

  const { createRuntime, createServer } = await import("@alexkroman1/aai/runtime");

  const hasClient = existsSync(path.join(cwd, "client.tsx"));
  const backendPort = hasClient ? port + 1 : port;

  // Without a custom client.tsx we serve the pre-built default aai-ui client.
  function resolveDefaultClientDir(): string {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@alexkroman1/aai-ui/package.json");
    return path.join(path.dirname(pkgPath), "dist", "default-client");
  }

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveAgentEnv(cwd);
  const runtime = createRuntime({ agent: agentDef, env });
  const agentServer = createServer({
    runtime,
    name: agentDef.name,
    ...(hasClient ? {} : { clientDir: resolveDefaultClientDir() }),
  });
  await agentServer.listen(backendPort);

  let viteServer: { close(): Promise<void> } | undefined;
  if (hasClient) {
    const { createServer: createViteServer } = await import("vite");
    const target = `http://localhost:${backendPort}`;
    viteServer = await createViteServer({
      root: cwd,
      plugins: [fallbackHtmlPlugin(cwd)],
      server: {
        port,
        proxy: {
          "/health": target,
          "/websocket": { target, ws: true },
        },
      },
    });
    await (viteServer as unknown as { listen(): Promise<void> }).listen();
  }

  let restarting = false;
  let currentServer: AgentServer = agentServer;

  async function restart(): Promise<void> {
    await currentServer.close().catch(() => {
      /* ignore close errors during restart */
    });
    try {
      const newAgentDef = await loadAgentDef(cwd);
      const newEnv = await resolveAgentEnv(cwd);
      const newServer = createServer({
        runtime: createRuntime({ agent: newAgentDef, env: newEnv }),
        name: newAgentDef.name,
        ...(hasClient ? {} : { clientDir: resolveDefaultClientDir() }),
      });
      await newServer.listen(backendPort);
      currentServer = newServer;
      log.success("Restarted");
    } catch (err) {
      log.error(`Restart failed: ${errorMessage(err)}`);
    }
  }

  const watchers = watchDirectory(cwd, () => {
    if (restarting) return;
    restarting = true;
    void restart().finally(() => {
      restarting = false;
    });
  });

  return async () => {
    for (const w of watchers) w.close();
    if (viteServer) await viteServer.close();
    await currentServer.close();
  };
}
