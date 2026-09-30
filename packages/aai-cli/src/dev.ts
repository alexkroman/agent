// Copyright 2025 the AAI authors. MIT license.

import path from "node:path";
import { styleText } from "node:util";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { startTracing } from "@alexkroman1/aai-runtime/tracing";
import { devBindHost } from "./_dev-env.ts";
import {
  HOOK_SHUTDOWN_TIMEOUT_MS,
  type QuickTunnel,
  runPublicUrlHook,
  startQuickTunnel,
} from "./_dev-tunnel.ts";
import { CliError, type CommandResult, ok } from "./_output.ts";
import { fmtUrl, log, notify, parsePort } from "./_ui.ts";
import { errorDetail } from "./_utils.ts";

type DevData = { url: string; publicUrl?: string };

/**
 * The tunnel and hook runners `executeDev` calls — the real ones unless a spec
 * hands in fakes, so the `--tunnel` wiring is unit-testable without spawning
 * `cloudflared` or a shell.
 */
export type DevTunnelDeps = {
  startQuickTunnel?: typeof startQuickTunnel;
  runPublicUrlHook?: typeof runPublicUrlHook;
};

/**
 * Start the dev server and return the result.
 * The process stays alive after this returns — caller handles signals.
 */
export async function executeDev(
  opts: {
    cwd: string;
    port: string;
    /** `--watch`. Undefined leaves it to `AAI_DEV_WATCH`, then to the TTY pair. */
    watch?: boolean | undefined;
    /** `--tunnel`: a cloudflared quick tunnel whose URL becomes `PUBLIC_URL`. */
    tunnel?: boolean | undefined;
    /** `--on-public-url`: run with `PUBLIC_URL` once up, and with it empty on exit. */
    onPublicUrl?: string | undefined;
  },
  deps: DevTunnelDeps = {},
): Promise<CommandResult<DevData>> {
  const startTunnel = deps.startQuickTunnel ?? startQuickTunnel;
  const runHookCommand = deps.runPublicUrlHook ?? runPublicUrlHook;
  const port = parsePort(opts.port);
  const agentName = path.basename(path.resolve(opts.cwd));
  const hook = opts.onPublicUrl?.trim() || undefined;
  if (hook && !opts.tunnel && !process.env.PUBLIC_URL?.trim()) {
    throw new CliError(
      "usage",
      "--on-public-url has no URL to run with.",
      "Pass --tunnel for a cloudflared quick tunnel, or export PUBLIC_URL.",
    );
  }
  const { startDevServer } = await import("./_dev-server.ts");

  // Graceful shutdown, installed BEFORE the multi-second startup (bundle +
  // listen + Vite boot): a Ctrl-C during boot used to hit Node's default
  // handler and skip teardown entirely. Once-guarded: SIGINT followed by
  // SIGTERM (common under process supervisors) must not run cleanup twice
  // concurrently — the second signal joins the in-flight teardown instead.
  let cleanup: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  // The tunnel, once up: closed on every exit path, including a mid-startup
  // signal, where the default exit would orphan `cloudflared`.
  let tunnel: QuickTunnel | undefined;
  const shutdown = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Mid-startup: no cleanup handle yet. Exiting kills the process group's
    // children (Vite) with it — 130 is the conventional SIGINT exit code.
    if (!cleanup) {
      void (tunnel?.close() ?? Promise.resolve()).finally(() => process.exit(exitCode || 130));
      return;
    }
    cleanup().then(
      () => process.exit(exitCode),
      (err: unknown) => {
        notify("error", `Shutdown failed: ${errorDetail(err)}`);
        process.exit(1);
      },
    );
  };
  const onSignal = () => shutdown(0);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Before the server: the first build reads `PUBLIC_URL` (`_dev-server.ts`),
  // and cloudflared answers with a URL before its origin is listening.
  if (opts.tunnel) {
    const origin = `http://${tunnelOriginHost()}:${port}`;
    log.info(`Starting a cloudflared quick tunnel to ${origin}…`);
    tunnel = await startTunnel({ origin });
    const exported = process.env.PUBLIC_URL?.trim();
    if (exported && exported !== tunnel.url) {
      notify("warn", `--tunnel replaces PUBLIC_URL=${exported} with ${tunnel.url} for this run.`);
    }
    process.env.PUBLIC_URL = tunnel.url;
    void tunnel.exited.then((code) => {
      if (shuttingDown) return;
      notify("error", `cloudflared exited (code ${code ?? "signal"}); the public URL is gone.`);
      shutdown(1);
    });
  }
  const publicUrl = process.env.PUBLIC_URL?.trim() || undefined;

  // Armed here rather than inside the dev server, which is REBUILT on every
  // save: starting a tracer per rebuild would register a provider per save.
  // Returns undefined unless a collector is configured, so the ordinary dev
  // loop pays one string read — see `@alexkroman1/aai-runtime/tracing`.
  const tracing = await startTracing();
  let serve: () => Promise<void>;
  try {
    serve = await startDevServer({ cwd: opts.cwd, port, watch: opts.watch });
  } catch (err) {
    await tunnel?.close();
    throw err;
  }
  cleanup = async () => {
    // The hook's withdrawal first, while the URL it names still answers.
    // Each `await` is guarded rather than written `await tunnel?.close()`: an
    // awaited `undefined` still yields, and a plain `aai dev` must start its
    // server teardown synchronously with the signal (`dev.test.ts`).
    if (hook && publicUrl)
      await runHook(runHookCommand, hook, "", opts.cwd, HOOK_SHUTDOWN_TIMEOUT_MS);
    if (tunnel) await tunnel.close();
    await serve();
    // After the server, so spans from a request still in flight are in the
    // batch this drains. Never rejects.
    await tracing?.shutdown();
  };

  const url = `http://localhost:${port}`;
  log.success(`${styleText("bold", agentName)} running at ${fmtUrl(url)}`);
  if (publicUrl) {
    // `notify`, not `log`: a supervisor reading a piped `aai dev` needs the one
    // line it cannot get anywhere else.
    notify("info", `Public URL: ${publicUrl}`);
    if (hook) await runHook(runHookCommand, hook, publicUrl, opts.cwd);
  }
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

  return ok({ url, ...omitUndefined({ publicUrl }) });
}

/**
 * The host the tunnel dials: loopback, unless `AAI_DEV_HOST` bound the server
 * to one specific interface (a wildcard bind still answers on loopback).
 */
function tunnelOriginHost(): string {
  const host = devBindHost();
  return host === undefined || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

/**
 * One run of the `--on-public-url` hook. A failing hook is REPORTED, not fatal:
 * the server is up and serving locally, and killing it over a publish step
 * would take the local half down with the public one.
 */
async function runHook(
  run: typeof runPublicUrlHook,
  command: string,
  url: string,
  cwd: string,
  timeoutMs?: number,
) {
  const phase = url ? "with the public URL" : "to withdraw the public URL";
  try {
    const code = await run(command, url, { cwd, timeoutMs });
    if (code !== 0) notify("warn", `--on-public-url exited ${code ?? "(timed out)"} ${phase}.`);
  } catch (err) {
    notify("warn", `--on-public-url could not run ${phase}: ${errorDetail(err)}`);
  }
}
