// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { colorize } from "consola/utils";
import { fmtUrl, log, parsePort } from "./_ui.ts";

export async function runDevCommand(opts: { cwd: string; port: string }): Promise<void> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const { startDevServer } = await import("./_dev-server.ts");
  const cleanup = await startDevServer({ cwd: opts.cwd, port });

  log.success(`${colorize("bold", agentName)} running at ${fmtUrl(`http://localhost:${port}`)}`);
  log.info("Press Ctrl-C to stop");

  // Graceful shutdown
  const onSignal = () => {
    void cleanup().finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
