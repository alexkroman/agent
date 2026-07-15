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

  // Defense-in-depth: a provider SDK can emit a stray unhandled rejection on a
  // background socket (e.g. a connect-time WebSocket failure such as a TTS
  // provider being out of credits). Log it and keep serving other sessions
  // instead of letting one failed session crash the whole dev host.
  process.on("unhandledRejection", (err) => {
    log.error(
      `Unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  });

  // Same rationale for synchronous throws that escape to the top of the event
  // loop (e.g. a provider SDK callback that throws during a concurrent
  // cold-start burst). Without this, one bad session's exception crashes the
  // whole host and drops every other in-flight connection with it. Log the
  // stack and keep serving so a single failure stays isolated to its session.
  process.on("uncaughtException", (err) => {
    log.error(
      `Uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  });

  return ok({ url });
}
