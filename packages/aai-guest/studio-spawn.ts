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
import { omitUndefined } from "@alexkroman1/aai/utils";

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
      ...omitUndefined({ env: opts.env }),
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

/**
 * The child's stdout with a KILL annotated onto it — the shape every surface
 * that returns one string to the model shares (`bash`, the npm tools, the
 * workspace test run). `runCapped` leaves the policy to the caller and reports
 * `signal`; what was copied three times was this sentence, not the decision.
 */
export function outputWithKillNote(result: SpawnCappedResult, timeoutMs: number): string {
  return result.signal
    ? `${result.stdout}\n[killed by ${result.signal} after ${timeoutMs}ms]`
    : result.stdout;
}

/** Wall-clock limit for one npm invocation. */
export const NPM_TIMEOUT_MS = 110_000;

/** Output tail kept from npm (errors print last). */
export const NPM_OUTPUT_CAP = 4000;

/**
 * npm package NAME: optional scope, then the name. No version part.
 *
 * Shared rather than per-caller because it is npm's vocabulary, not any one
 * tool's policy — it was written out twice, byte for byte, in
 * `studio-project-tools.ts` and `studio-workspace-deps.ts`.
 */
export const PACKAGE_NAME_RE = /^(@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/;

/**
 * Run one npm command with this package's standing flags and policy.
 *
 * Every npm spawn in the guest goes through here. It existed twice — once in
 * `studio-project-tools.ts` for the dependency tools and once inline in
 * `studio-workspace-deps.ts` — and the copies had ALREADY drifted on how a
 * killed child reads, which is the exact failure this module's header says it
 * was created to end. `signal` stays on the result so a caller can still
 * choose its own wording; what is shared is the flag tail, the env, the
 * default timeout and the cap. `timeoutMs` overrides the default for a caller
 * spending one budget across several runs.
 */
export function runNpm(
  dir: string,
  args: string[],
  timeoutMs = NPM_TIMEOUT_MS,
): Promise<SpawnCappedResult> {
  return runCapped("npm", [...args, "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: dir,
    env: envWithoutGuestToken(),
    timeoutMs,
    cap: NPM_OUTPUT_CAP,
    combineStreams: true,
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
