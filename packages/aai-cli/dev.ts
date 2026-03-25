// Copyright 2025 the AAI authors. MIT license.

import { buildAgentBundle } from "./_build.ts";
import { bootServer, loadAgentDef, resolveServerEnv } from "./_server-common.ts";
import { info, runCommand, step } from "./_ui.ts";

export async function _startDevServer(
  cwd: string,
  port: number,
  log: (msg: string) => void,
  opts?: { check?: boolean },
): Promise<void> {
  const bundle = await buildAgentBundle(cwd, log);

  const agentDef = await loadAgentDef(cwd);
  const env = await resolveServerEnv();
  const server = await bootServer(agentDef, bundle.clientDir, env, port);
  log(step("Ready", `http://localhost:${port}`));

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
    log(step("Health", health.name ?? "ok"));

    const pageRes = await fetch(`${base}/`);
    if (!pageRes.ok) {
      throw new Error(`GET / returned ${pageRes.status}`);
    }
    const html = await pageRes.text();
    if (!(html.includes("<") && html.includes("html"))) {
      throw new Error("GET / did not return valid HTML");
    }
    log(step("Client", "ok"));
  } catch (err) {
    await server.close();
    throw err;
  }

  // --check: exit after verification instead of staying up
  if (opts?.check) {
    await server.close();
  } else {
    log(info("Ctrl-C to quit"));
  }
}

export async function runDevCommand(opts: {
  cwd: string;
  port: string;
  check?: boolean;
}): Promise<void> {
  const port = Number.parseInt(opts.port, 10);

  await runCommand(async ({ log }) => {
    await _startDevServer(opts.cwd, port, log, opts.check ? { check: true } : undefined);
  });
}
