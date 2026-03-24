// Copyright 2025 the AAI authors. MIT license.

import type { ReactNode } from "react";
import { buildAgentBundle } from "./_build.tsx";
import { runWithInk, Step } from "./_ink.tsx";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server_common.ts";

export async function _startDevServer(
  cwd: string,
  port: number,
  log: (node: ReactNode) => void,
  opts?: { check?: boolean },
): Promise<void> {
  const bundle = await buildAgentBundle(cwd, log);

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  const server = await bootServer(agentDef, bundle.clientDir, env, port);
  log(<Step action="Ready" msg={`http://localhost:${port}`} />);

  // Verify agent + client are healthy after boot
  const base = `http://localhost:${port}`;
  try {
    const healthRes = await fetch(`${base}/health`);
    if (!healthRes.ok) {
      throw new Error(`GET /health returned ${healthRes.status}`);
    }
    const health = (await healthRes.json()) as { status: string; name?: string };
    if (health.status !== "ok") {
      throw new Error(`GET /health returned ${JSON.stringify(health)}`);
    }
    log(<Step action="Health" msg={health.name ?? "ok"} />);

    const pageRes = await fetch(`${base}/`);
    if (!pageRes.ok) {
      throw new Error(`GET / returned ${pageRes.status}`);
    }
    const html = await pageRes.text();
    if (!(html.includes("<") && html.includes("html"))) {
      throw new Error("GET / did not return valid HTML");
    }
    log(<Step action="Client" msg="ok" />);
  } catch (err) {
    await server.close();
    throw err;
  }

  // --check: exit after verification instead of staying up
  if (opts?.check) {
    await server.close();
  }
}

export async function runDevCommand(opts: {
  cwd: string;
  port: string;
  check?: boolean;
}): Promise<void> {
  const port = Number.parseInt(opts.port, 10);

  await runWithInk(async ({ log }) => {
    await _startDevServer(opts.cwd, port, log, opts.check ? { check: true } : undefined);
  });
}
