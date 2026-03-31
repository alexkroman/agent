// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { colorize } from "consola/utils";
import { createServer as createViteServer } from "vite";
import { fmtUrl, log, parsePort } from "./lib/ui.ts";

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const vite = await createViteServer({
    root: opts.cwd,
    server: { port },
  });
  await vite.listen();

  log.success(`${colorize("bold", agentName)} running at ${fmtUrl(`http://localhost:${port}`)}`);
  log.info("Press Ctrl-C to stop");
}
