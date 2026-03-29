// Copyright 2025 the AAI authors. MIT license.

import { createClientDevServer } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { consola, parsePort } from "./_ui.ts";

export async function _startDevServer(cwd: string, port: number): Promise<void> {
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  // Single-process dev server: the aai Vite plugin boots the agent runtime
  // as middleware inside the Vite dev server. No separate backend needed.
  const vite = await createClientDevServer(cwd, port);
  await vite.listen();
  consola.success(`Ready http://localhost:${port}`);

  if (agent.clientEntry) {
    consola.info("Agent + client HMR running in a single Vite server");
  } else {
    consola.info("No client.tsx found — serving agent API only");
  }

  consola.info("Ctrl-C to quit");
}

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  await _startDevServer(opts.cwd, port);
}
