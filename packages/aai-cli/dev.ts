// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { colorize } from "consola/utils";
import { type CommandResult, ok } from "./_output.ts";
import { fmtUrl, log, parsePort } from "./_ui.ts";

type DevData = { url: string };

/**
 * Start the dev server and return the result.
 * The process stays alive after this returns — caller handles signals.
 */
export async function executeDev(opts: {
  cwd: string;
  port: string;
}): Promise<CommandResult<DevData>> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const { startDevServer } = await import("./_dev-server.ts");
  const cleanup = await startDevServer({ cwd: opts.cwd, port });

  const url = `http://localhost:${port}`;
  log.success(`${colorize("bold", agentName)} running at ${fmtUrl(url)}`);
  log.info("Press Ctrl-C to stop");

  // Graceful shutdown
  const onSignal = () => {
    void cleanup().finally(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return ok({ url });
}
