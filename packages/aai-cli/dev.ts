// Copyright 2025 the AAI authors. MIT license.

import { buildAgentBundle, createClientDevServer } from "./_bundler.ts";
import { loadAgent } from "./_discover.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server-common.ts";
import { consola, parsePort } from "./_ui.ts";

/** Build, boot, and verify the server — used by `--check` mode. */
async function runCheckMode(cwd: string, port: number): Promise<void> {
  const bundle = await buildAgentBundle(cwd);
  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv(cwd);
  const server = await bootServer(agentDef, bundle.clientDir, env, port);
  consola.success(`Ready http://localhost:${port}`);

  const base = `http://localhost:${port}`;
  try {
    const healthRes = await fetch(`${base}/health`);
    if (!healthRes.ok) {
      throw new Error(
        `GET /health returned ${healthRes.status}. The server started but the health endpoint failed.`,
      );
    }
    const health = (await healthRes.json()) as { status: string; name?: string };
    if (health.status !== "ok") {
      throw new Error(
        `GET /health returned unhealthy status: ${JSON.stringify(health)}. Check your agent.ts for errors.`,
      );
    }
    consola.success(`Health ${health.name ?? "ok"}`);

    const pageRes = await fetch(`${base}/`);
    if (!pageRes.ok) {
      throw new Error(`GET / returned ${pageRes.status}. The client page failed to load.`);
    }
    const html = await pageRes.text();
    if (!(html.includes("<") && html.includes("html"))) {
      throw new Error(
        "GET / did not return valid HTML. Check that client.tsx exists and builds correctly.",
      );
    }
    consola.success("Client ok");
  } catch (err: unknown) {
    await server.close();
    throw err;
  }

  await server.close();
}

export async function _startDevServer(
  cwd: string,
  port: number,
  opts?: { check?: boolean },
): Promise<void> {
  if (opts?.check) {
    await runCheckMode(cwd, port);
    return;
  }

  // Dev mode: Vite dev server for client HMR
  const agent = await loadAgent(cwd);
  if (!agent) {
    throw new Error("No agent found — run `aai init` first");
  }

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();

  // Backend runs on an internal port; Vite proxies to it
  const backendPort = port + 1;
  await bootServer(agentDef, undefined, env, backendPort);

  if (agent.clientEntry) {
    const vite = await createClientDevServer(cwd, backendPort, port);
    await vite.listen();
    consola.success(`Ready http://localhost:${port}`);
    consola.info("Client HMR enabled — edits to client.tsx update instantly");
  } else {
    consola.success(`Ready http://localhost:${backendPort}`);
    consola.info("No client.tsx found — serving agent API only");
  }

  consola.info("Ctrl-C to quit");
}

export async function runDevCommand(opts: {
  cwd: string;
  port: string;
  check?: boolean;
}): Promise<void> {
  const port = parsePort(opts.port);
  await _startDevServer(opts.cwd, port, opts.check ? { check: true } : undefined);
}
