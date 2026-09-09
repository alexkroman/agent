// Copyright 2026 the AAI authors. MIT license.
/**
 * One child-process runner for every tool that shells out.
 *
 * A coding agent's `bash` — and everything a host builds on top of it: an
 * install, a build, a test run — is the same three steps every time: spawn,
 * cap each stream to a kept TAIL, settle on close. Five hand-rolled copies of
 * that in the guest harness had already drifted on signal and cap semantics
 * before this became one function, which is the whole argument for it: the
 * policy differences that remain (reject vs annotate on a kill, combined vs
 * separate streams) are the CALLER's, and are decided on the result this
 * returns rather than inside it.
 *
 * The tail rather than the head, in every case: a compiler, a test runner and
 * a package manager all print the thing that went wrong LAST, so a head-capped
 * capture is reliably the half with no information in it.
 *
 * stdin is always `ignore`: none of these children read it, and an open pipe
 * the parent never writes lets a child like a bare `cat` block until the
 * timeout instead of seeing EOF.
 */

// Spawning a child is what this module IS, and the ban's stated reason ("not
// available in Firecracker guest VMs") does not describe where this runs — the
// `bash` tool over this runner is meant for a container, and the studio's
// coding agent has spawned npm, bash and the bundler inside a Modal guest on
// every build for as long as it has existed. Same suppression, same argument,
// as `_ffmpeg-spawn.ts` one file over; scoped to this LINE rather than lifted
// for the file, so the other eight restricted modules stay banned here.
// biome-ignore lint/style/noRestrictedImports: see above.
import { spawn } from "node:child_process";
import { omitUndefined } from "../sdk/omit-undefined.ts";

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

/** What {@link runCapped} takes beyond the command itself. */
export type RunCappedOptions = {
  /** Working directory for the child. */
  cwd: string;
  /**
   * Child env. Defaults to this process's own, which is what a CLI-shaped host
   * wants and what a SANDBOXED one must override: a child running code the
   * model wrote should be handed an allow-list, so a credential the host holds
   * is out by construction rather than by remembering to subtract it.
   */
  env?: NodeJS.ProcessEnv;
  /** Wall-clock limit; past it the child is killed and `signal` is set. */
  timeoutMs: number;
  /** Tail kept per captured stream. */
  cap: number;
  /** Interleave stderr into `stdout` in arrival order — the shell-tool shape. */
  combineStreams?: boolean;
};

/**
 * Run one child process, capturing capped output tails. Rejects only when the
 * process could not be spawned; a killed child RESOLVES with `signal` set so
 * the caller picks the failure shape its own output contract needs.
 *
 * With `combineStreams`, stderr interleaves into `stdout` in arrival order and
 * `stderr` comes back empty.
 */
export function runCapped(
  cmd: string,
  args: string[],
  opts: RunCappedOptions,
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
 * that returns one string to the model shares.
 *
 * {@link runCapped} leaves the policy to the caller and reports `signal`; what
 * was copied three times is this SENTENCE, not the decision. Without it a
 * command killed at its deadline reads to the model as one that finished and
 * printed nothing, which it then believes.
 */
export function outputWithKillNote(result: SpawnCappedResult, timeoutMs: number): string {
  return result.signal
    ? `${result.stdout}\n[killed by ${result.signal} after ${timeoutMs}ms]`
    : result.stdout;
}
