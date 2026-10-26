// Copyright 2026 the AAI authors. MIT license.
/**
 * `aai dev --tunnel` — a public URL for the dev server, and a hook to hand it
 * to whoever must dial in.
 *
 * A carrier placing a call (`agent({ telephony })` → `WS /phone`), a webhook
 * provider, a workflow's `publicWebhookUrl` — each needs to reach a laptop
 * that has no public address. Every project that needed one wrote the same
 * forty lines of shell: start `cloudflared`, poll its log for the
 * `trycloudflare.com` URL, export it, publish it somewhere, withdraw it on
 * exit, and stop when either process died. This is those lines, once.
 *
 * - **A Cloudflare QUICK tunnel**: no account, a fresh
 *   `https://<random>.trycloudflare.com` per run. The binary is
 *   `AAI_CLOUDFLARED_PATH`, else `cloudflared` on `PATH`; missing, the command
 *   fails naming the install, and never installs anything.
 * - **It points at the port `aai dev` prints** — Vite's when there is a
 *   `client.tsx`, whose proxy table forwards `/phone`, `/api`, `/workflows`
 *   and the sockets (`_dev-vite-config.ts`).
 * - **The URL becomes `PUBLIC_URL`** before the first build, which is what
 *   `createRuntime`'s `publicUrl` and `ctx.workflows.publicWebhookUrl` mint
 *   from (see `_dev-server.ts`).
 * - **`--on-public-url <cmd>` runs twice**: once with `PUBLIC_URL` set, after
 *   the server is up, and once with it EMPTY on shutdown — so a hook that
 *   publishes the URL withdraws it with the same line, and nothing is left
 *   dialling a tunnel that is gone. A SIGKILL skips the second run; nothing
 *   can prevent that.
 * - **The tunnel dying ends `aai dev`** (exit 1): a server that has silently
 *   lost its only public route looks healthy locally and is dead to every
 *   caller.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { omitUndefined } from "@alexkroman1/aai/utils";
import pTimeout from "p-timeout";
import { CliError } from "./_output.ts";

/**
 * A quick tunnel's URL, as `cloudflared` prints it (to stderr, in a box) —
 * never `api.trycloudflare.com`, the endpoint it names when the request for a
 * tunnel FAILS (`Post "https://api.trycloudflare.com/tunnel": …`), which a
 * looser pattern would hand out as the public URL.
 */
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/** How long `cloudflared` may take to print a URL before we give up. */
export const TUNNEL_URL_TIMEOUT_MS = 60_000;

/** How long the shutdown run of the hook may take. */
export const HOOK_SHUTDOWN_TIMEOUT_MS = 10_000;

/** The first quick-tunnel URL in `text`, or `undefined`. */
export function scrapeTunnelUrl(text: string): string | undefined {
  return QUICK_TUNNEL_URL_RE.exec(text)?.[0];
}

/** The `cloudflared` to run: `AAI_CLOUDFLARED_PATH`, else the one on `PATH`. */
export function cloudflaredBinary(env: Record<string, string | undefined> = process.env): string {
  return env.AAI_CLOUDFLARED_PATH?.trim() || "cloudflared";
}

/**
 * How a child is started — `node:child_process`'s `spawn` unless a spec hands
 * in a fake, so the process handling is unit-testable without a subprocess.
 */
export type SpawnFn = {
  (command: string, args: readonly string[], options: SpawnOptions): TunnelChild;
  (command: string, options: SpawnOptions): TunnelChild;
};

/** The part of a `ChildProcess` this module touches — all a fake has to be. */
export type TunnelChild = Pick<
  ChildProcess,
  "stdout" | "stderr" | "exitCode" | "signalCode" | "kill" | "pid"
> & {
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
};

/** A running quick tunnel. */
export type QuickTunnel = {
  readonly url: string;
  /** Resolves with the exit code when `cloudflared` exits, for any reason. */
  readonly exited: Promise<number | null>;
  /** Stop it (SIGTERM). Idempotent. */
  close(): Promise<void>;
};

/** The last `max` characters of `text`, for an error that quotes a log. */
function tail(text: string, max = 2000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function notInstalled(binary: string): CliError {
  return new CliError(
    "tunnel_unavailable",
    `--tunnel needs cloudflared, and \`${binary}\` could not be started.`,
    "Install it (`brew install cloudflared`, or see " +
      "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), " +
      "or point AAI_CLOUDFLARED_PATH at the binary.",
  );
}

/**
 * Start a quick tunnel to `origin` and resolve once it has printed its URL.
 *
 * Rejects with `tunnel_unavailable` when the binary cannot be spawned, and
 * `tunnel_failed` when it exits or stays silent past `timeoutMs` — quoting the
 * end of its output, which is where `cloudflared` says why.
 */
export async function startQuickTunnel(opts: {
  origin: string;
  binary?: string | undefined;
  timeoutMs?: number | undefined;
  spawn?: SpawnFn | undefined;
}): Promise<QuickTunnel> {
  const binary = opts.binary ?? cloudflaredBinary();
  const spawn = opts.spawn ?? nodeSpawn;
  const child: TunnelChild = spawn(binary, ["tunnel", "--no-autoupdate", "--url", opts.origin], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const found = Promise.withResolvers<string>();
  // A spawn that FAILS (ENOENT) emits `error` and never `exit`, so both end it
  // — or `close()` below would wait forever on a process that never existed.
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  child.once("error", (err: NodeJS.ErrnoException) => {
    found.reject(err.code === "ENOENT" || err.code === "EACCES" ? notInstalled(binary) : err);
  });
  const onChunk = (chunk: Buffer): void => {
    output = tail(output + chunk.toString("utf8"), 8000);
    const url = scrapeTunnelUrl(output);
    if (url !== undefined) found.resolve(url);
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  void exited.then((code) => {
    found.reject(
      new CliError(
        "tunnel_failed",
        `cloudflared exited (code ${code ?? "signal"}) before printing a tunnel URL.`,
        tail(output) || undefined,
      ),
    );
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };

  try {
    const url = await pTimeout(found.promise, {
      milliseconds: opts.timeoutMs ?? TUNNEL_URL_TIMEOUT_MS,
      message: new CliError(
        "tunnel_failed",
        `cloudflared printed no tunnel URL within ${Math.round((opts.timeoutMs ?? TUNNEL_URL_TIMEOUT_MS) / 1000)}s.`,
        tail(output) || undefined,
      ),
    });
    return { url, exited, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** How long the startup run of the hook may take before it is stopped. */
export const HOOK_STARTUP_TIMEOUT_MS = 60_000;

/** How long a stopped hook gets between SIGTERM and SIGKILL. */
export const HOOK_KILL_GRACE_MS = 2000;

/**
 * Whether the hook gets its own process group. Not on Windows: there is no
 * `process.kill(-pgid)`, and `detached` opens a new console window instead.
 */
const PROCESS_GROUPS = process.platform !== "win32";

/** Signal a process GROUP — the seam a spec replaces to watch the signals. */
export type KillGroupFn = (pgid: number, signal: NodeJS.Signals) => void;

/** `process.kill(-pgid)`; a group already gone (ESRCH) is not an error. */
const killGroupDefault: KillGroupFn = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* the group has exited — nothing left to stop */
  }
};

/** Why {@link runPublicUrlHook}'s wait ended without an exit code. */
const STOPPED = Symbol("stopped");

/**
 * Run the `--on-public-url` hook through the shell with `PUBLIC_URL` (and its
 * alias `AAI_PUBLIC_URL`) set to `url` — empty on the shutdown run. Resolves
 * with the exit code, or `null` when it was stopped — past `timeoutMs`, or on
 * `signal`; output is inherited, so the hook speaks for itself.
 *
 * **The hook is its own process GROUP, and stopping it signals the group**
 * (SIGTERM, then SIGKILL after `killGraceMs`). `shell: true` is `sh -c`, so
 * signalling the child signalled only the shell: a hook that ran
 * `./publish.sh` (or anything not `exec`ed) left its real process running
 * past the timeout and past `aai dev`'s exit. Detached for the same reason —
 * the group must not be the terminal's, whose Ctrl-C would reach the hook
 * before `aai dev` had decided what to do with it.
 */
export async function runPublicUrlHook(
  command: string,
  url: string,
  opts: {
    cwd: string;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    spawn?: SpawnFn | undefined;
    killGroup?: KillGroupFn | undefined;
    killGraceMs?: number | undefined;
  },
): Promise<number | null> {
  const spawn = opts.spawn ?? nodeSpawn;
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    detached: PROCESS_GROUPS,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PUBLIC_URL: url, AAI_PUBLIC_URL: url },
  });
  // A spawn failure is RECORDED, not raced: the abort below must not turn a
  // hook that could not start into a silent stop.
  let spawnError: unknown;
  const done = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", (err) => {
      spawnError = err;
      resolve(null);
    });
  });
  let outcome: number | null | typeof STOPPED;
  try {
    outcome = await pTimeout(done, {
      milliseconds: opts.timeoutMs ?? Number.POSITIVE_INFINITY,
      fallback: () => STOPPED,
      ...omitUndefined({ signal: opts.signal }),
    });
  } catch {
    // Only the abort rejects: `done` never does.
    outcome = STOPPED;
  }
  if (spawnError !== undefined) throw spawnError;
  if (outcome !== STOPPED) return outcome;
  await stopGroup(child, done, opts.killGroup ?? killGroupDefault, opts.killGraceMs);
  return null;
}

/**
 * SIGTERM the hook's group, give it `graceMs` to go, then SIGKILL the group
 * whether or not the shell has exited — a grandchild ignoring SIGTERM outlives
 * its shell. A child with no pid (it never started), or one on Windows (no
 * groups), is signalled directly.
 */
async function stopGroup(
  child: TunnelChild,
  exited: Promise<unknown>,
  killGroup: KillGroupFn,
  graceMs = HOOK_KILL_GRACE_MS,
): Promise<void> {
  const signal = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined || !PROCESS_GROUPS) child.kill(sig);
    else killGroup(child.pid, sig);
  };
  signal("SIGTERM");
  await pTimeout(
    exited.catch(() => undefined),
    { milliseconds: graceMs, fallback: () => undefined },
  );
  signal("SIGKILL");
}
