// Copyright 2025 the AAI authors. MIT license.

import { createServer as createViteServer } from "vite";
import { consola, parsePort } from "./_ui.ts";

export async function runDevCommand(opts: {
  cwd: string;
  port: string;
  check?: boolean;
}): Promise<void> {
  const port = parsePort(opts.port);

  if (opts.check) {
    const { buildAgentBundle } = await import("./_bundler.ts");
    const { bootServer, loadAgentDef, resolveServerEnv } = await import("./_server-common.ts");
    const bundle = await buildAgentBundle(opts.cwd);
    const agentDef = await loadAgentDef(opts.cwd);
    const env = await resolveServerEnv(opts.cwd);
    const server = await bootServer(agentDef, bundle.clientDir, env, port);
    consola.success(`Ready http://localhost:${port}`);
    try {
      const base = `http://localhost:${port}`;
      const healthRes = await fetch(`${base}/health`);
      if (!healthRes.ok) throw new Error(`GET /health returned ${healthRes.status}`);
      consola.success("Health ok");
      const pageRes = await fetch(`${base}/`);
      if (!pageRes.ok) throw new Error(`GET / returned ${pageRes.status}`);
      consola.success("Client ok");
    } finally {
      await server.close();
    }
    return;
  }

  // Dev mode: start Vite (the aai plugin boots the backend automatically)
  const vite = await createViteServer({
    root: opts.cwd,
    server: { port },
  });
  await vite.listen();
  consola.success(`Ready http://localhost:${port}`);
  consola.info("Ctrl-C to quit");
}
