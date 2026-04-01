// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CLIENT_HTML } from "./lib/default-client.ts";
import { fileExists } from "./lib/discover.ts";
import { loadAgent, resolveServerEnv } from "./lib/server-common.ts";
import { fmtUrl, log, parsePort } from "./lib/ui.ts";

function resolveClientHtml(cwd: string): string {
  const userHtml = path.join(cwd, "index.html");
  if (fs.existsSync(userHtml)) {
    return fs.readFileSync(userHtml, "utf-8");
  }
  return DEFAULT_CLIENT_HTML;
}

export async function _startProductionServer(cwd: string, port: number): Promise<void> {
  log.step("Loading agent");
  const agentDef = await loadAgent(cwd);
  const env = await resolveServerEnv(cwd);
  const clientHtml = resolveClientHtml(cwd);

  const { createRuntime, createServer } = await import("@alexkroman1/aai/server");
  const runtime = createRuntime({ agent: agentDef, env });
  const server = createServer({ runtime, name: agentDef.name, clientHtml });
  await server.listen(port);
  log.success(`Listening on ${fmtUrl(`http://localhost:${port}`)}`);
}

export async function runStartCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const buildDir = path.join(opts.cwd, ".aai", "build");

  if (!(await fileExists(path.join(buildDir, "worker.js")))) {
    throw new Error("No build found — run `aai build` first");
  }

  log.step(`Starting server on port ${port}`);
  await _startProductionServer(opts.cwd, port);
}
