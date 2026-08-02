// Copyright 2026 the AAI authors. MIT license.
/**
 * One child-process runner for every guest spawn site — builds, Publish,
 * `bash`, npm, and the workspace test run. Five hand-rolled copies of
 * "spawn → cap each stream to a kept tail → settle on close" had already
 * drifted on signal and cap semantics; the policy differences that remain
 * (reject vs annotate on a kill, combined vs separate streams) are the
 * caller's, decided on the result this returns.
 *
 * stdin is always `ignore`: none of these children read it, and an open
 * pipe the parent never writes lets a child like a bare `cat` block until
 * the timeout instead of seeing EOF.
 */

import { spawn } from "node:child_process";

/** Output tail kept per stream from a CLI child (build / deploy envelopes). */
export const CLI_OUTPUT_CAP = 32_000;

export type SpawnCappedResult = {
  exitCode: number | null;
  /** Set when the child was killed — usually the wall-clock timeout. */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

/** Keep the tail of `text`, marking the elision — errors print last. */
export const keepTail = (text: string, cap: number): string =>
  text.length > cap ? `…${text.slice(-cap)}` : text;

/**
 * Run one child process, capturing capped output tails. Rejects only when
 * the process could not be spawned; a killed child resolves with `signal`
 * set so the caller picks the failure shape its output contract needs.
 * With `combineStreams`, stderr interleaves into `stdout` in arrival order
 * (the shell-tool shape) and `stderr` comes back empty.
 */
export function runCapped(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    /** Child env; defaults to this process's. */
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    /** Tail kept per captured stream. */
    cap: number;
    combineStreams?: boolean;
  },
): Promise<SpawnCappedResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout + chunk.toString(), opts.cap);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (opts.combineStreams) stdout = keepTail(stdout + chunk.toString(), opts.cap);
      else stderr = keepTail(stderr + chunk.toString(), opts.cap);
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

/** The last non-empty stdout line parsed as JSON — the one-line envelope
 * contract the build child and the CLI's `--json` mode share. */
export function parseLastJsonLine<T>(stdout: string): T | null {
  const line = stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/**
 * `process.env` minus the control-channel bearer token — the env for
 * children that run workspace-controlled code (`bash`, npm scripts), so
 * workspace code can't impersonate the host on a future connection.
 */
export function envWithoutGuestToken(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AAI_GUEST_TOKEN;
  return env;
}

/**
 * Nothing from this process's env but PATH — for children that need no
 * credentials at all (the build child, the deploy CLI), where the guest's
 * bearer token must not reach them either.
 */
export function pathOnlyEnv(): Record<string, string> {
  return process.env.PATH === undefined ? {} : { PATH: process.env.PATH };
}
