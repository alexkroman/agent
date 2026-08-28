// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { styleText } from "node:util";
import { type CommandResult, ok } from "./_output.ts";
import { fmtUrl, log, notify, parsePort } from "./_ui.ts";
import { errorDetail } from "./_utils.ts";

type DevData = { url: string };

/**
 * Start the dev server and return the result.
 * The process stays alive after this returns — caller handles signals.
 */
export async function executeDev(opts: {
  cwd: string;
  port: string;
  /** `--watch`. Undefined leaves the decision to `AAI_DEV_WATCH`. */
  watch?: boolean | undefined;
}): Promise<CommandResult<DevData>> {
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const { startDevServer } = await import("./_dev-server.ts");

  // Graceful shutdown, installed BEFORE the multi-second startup (bundle +
  // listen + Vite boot): a Ctrl-C during boot used to hit Node's default
  // handler and skip teardown entirely. Once-guarded: SIGINT followed by
  // SIGTERM (common under process supervisors) must not run cleanup twice
  // concurrently — the second signal joins the in-flight teardown instead.
  let cleanup: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Mid-startup: no cleanup handle yet. Exiting kills the process group's
    // children (Vite) with it — 130 is the conventional SIGINT exit code.
    if (!cleanup) process.exit(130);
    cleanup().then(
      () => process.exit(0),
      (err: unknown) => {
        notify("error", `Shutdown failed: ${errorDetail(err)}`);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  cleanup = await startDevServer({ cwd: opts.cwd, port, watch: opts.watch });

  const url = `http://localhost:${port}`;
  log.success(`${styleText("bold", agentName)} running at ${fmtUrl(url)}`);
  log.info("Press Ctrl-C to stop");

  // Defense-in-depth: a provider SDK can emit a stray unhandled rejection on a
  // background socket (e.g. a connect-time WebSocket failure such as a TTS
  // provider being out of credits). Log it and keep serving other sessions
  // instead of letting one failed session crash the whole dev host.
  process.on("unhandledRejection", (err) => {
    notify("error", `Unhandled rejection: ${errorDetail(err)}`);
  });

  // Same rationale for synchronous throws that escape to the top of the event
  // loop (e.g. a provider SDK callback that throws during a concurrent
  // cold-start burst). Without this, one bad session's exception crashes the
  // whole host and drops every other in-flight connection with it. Log the
  // stack and keep serving so a single failure stays isolated to its session.
  process.on("uncaughtException", (err) => {
    notify("error", `Uncaught exception: ${errorDetail(err)}`);
  });

  return ok({ url });
}
