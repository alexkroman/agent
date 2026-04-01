// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs";
import path from "node:path";
import { colorize } from "consola/utils";
import { DEFAULT_CLIENT_HTML } from "./lib/default-client.ts";
import { loadAgent, resolveServerEnv } from "./lib/server-common.ts";
import { fmtUrl, log, parsePort } from "./lib/ui.ts";

/** Read user's index.html or fall back to the built-in default client. */
function resolveClientHtml(cwd: string): string {
  const userHtml = path.join(cwd, "index.html");
  if (fs.existsSync(userHtml)) {
    return fs.readFileSync(userHtml, "utf-8");
  }
  return DEFAULT_CLIENT_HTML;
}

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));

  let server: { close(): Promise<void> } | null = null;

  async function boot(): Promise<void> {
    const agentDef = await loadAgent(opts.cwd);
    const env = await resolveServerEnv(opts.cwd);
    const clientHtml = await resolveClientHtml(opts.cwd);

    const { createRuntime, createServer } = await import("@alexkroman1/aai/server");
    const runtime = createRuntime({ agent: agentDef, env });
    const agentServer = createServer({ runtime, name: agentDef.name, clientHtml });
    await agentServer.listen(port);
    server = agentServer;
  }

  await boot();
  log.success(`${colorize("bold", agentName)} running at ${fmtUrl(`http://localhost:${port}`)}`);

  // Watch agent.toml and tools.ts for changes
  const watchFiles = ["agent.toml", "tools.ts"];
  const watchers: fs.FSWatcher[] = [];
  let reloading = false;

  for (const file of watchFiles) {
    const filePath = path.join(opts.cwd, file);
    if (!fs.existsSync(filePath)) continue;

    const watcher = fs.watch(filePath, async () => {
      if (reloading) return;
      reloading = true;
      try {
        log.step(`${file} changed, reloading...`);
        if (server) await server.close();
        server = null;
        await boot();
        log.success(`Reloaded — ${fmtUrl(`http://localhost:${port}`)}`);
      } catch (err) {
        log.error(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        reloading = false;
      }
    });
    watchers.push(watcher);
  }

  // Also watch index.html if it exists
  const indexPath = path.join(opts.cwd, "index.html");
  if (fs.existsSync(indexPath)) {
    const watcher = fs.watch(indexPath, async () => {
      if (reloading) return;
      reloading = true;
      try {
        log.step("index.html changed, reloading...");
        if (server) await server.close();
        server = null;
        await boot();
        log.success(`Reloaded — ${fmtUrl(`http://localhost:${port}`)}`);
      } catch (err) {
        log.error(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        reloading = false;
      }
    });
    watchers.push(watcher);
  }

  log.info("Watching for changes. Press Ctrl-C to stop.");
}
