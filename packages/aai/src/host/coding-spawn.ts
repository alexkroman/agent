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
  /**
   * Whether the wall-clock deadline fired. Its own fact rather than inferred
   * from `signal`: a child that TRAPS SIGTERM and exits on its own reports
   * `signal: null`, and one that exits 0 in the grace window reports
   * `exitCode: 0`, and both were still cut off.
   */
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

/**
 * How long a timed-out child's process group gets to exit on SIGTERM before it
 * is SIGKILLed. Long enough for a test runner or package manager to flush and
 * clean up; a child still alive after it is not going to exit on its own.
 */
export const KILL_GRACE_MS = 2000;

/**
 * How long after the child EXITS its output pipes may stay open before the
 * runner stops waiting for them.
 *
 * `close` waits for every holder of the child's stdout/stderr, and a command
 * that backgrounds something (`npm run dev &`, `sleep 60 &`) hands the pipes to
 * a process that may never exit. Settling on `close` alone made that call last
 * as long as the background job — past the deadline, since the deadline only
 * watches the direct child. Anything the child itself wrote is already in the
 * pipe by the time it exits, so this window only ever loses output a
 * BACKGROUND process writes later.
 */
export const EXIT_DRAIN_MS = 500;

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
 * process could not be spawned; a killed child RESOLVES with `signal` and
 * `timedOut` set so the caller picks the failure shape its own output contract
 * needs.
 *
 * With `combineStreams`, stderr interleaves into `stdout` in arrival order and
 * `stderr` comes back empty.
 *
 * ## The deadline kills the whole process GROUP, and escalates
 *
 * This used to be Node's `timeout:` spawn option, which sends ONE SIGTERM to
 * the direct child and nothing else. Two commands the `bash` tool is handed
 * routinely beat that, both reproduced:
 *
 * - `trap '' TERM; sleep 4` under a 300ms deadline ran the full 4s and came
 *   back `code 0, signal null`, so the model was told it succeeded.
 * - `sleep 5 & echo started` exited in 6ms and settled at ~5000ms, because the
 *   background job held the pipes open — and the deadline never fired at all,
 *   the direct child having already exited.
 *
 * So on POSIX the child leads its own process group (`detached`), the deadline
 * signals the GROUP — grandchildren included — with SIGTERM and then SIGKILL
 * after {@link KILL_GRACE_MS}, and the promise settles at `exit` plus at most
 * {@link EXIT_DRAIN_MS} rather than waiting on every pipe holder. A group that
 * is still alive when THIS process exits is SIGKILLed on the way out, because
 * `detached` also takes the child out of the terminal's Ctrl-C.
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
      detached: GROUP_KILL,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const group = trackGroup(child.pid);

    const deadline = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      escalation = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    }, opts.timeoutMs);

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(drain);
      // A timed-out command's stragglers are part of what was cut off: the
      // direct child may have exited on SIGTERM while a grandchild that ignores
      // it still holds the pipes, and settling cancels the escalation that
      // would have reached it.
      if (timedOut) killTree(child, "SIGKILL");
      group.settled();
      // Stop reading pipes a background job may still hold; its later output
      // is not this command's.
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout + chunk.toString(), opts.cap);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (opts.combineStreams) stdout = keepTail(stdout + chunk.toString(), opts.cap);
      else stderr = keepTail(stderr + chunk.toString(), opts.cap);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      group.settled();
      reject(err);
    });
    child.on("exit", (exitCode, signal) => {
      // An ordinary command's background jobs are left running — that is what
      // `&` asked for — and only the wait for their pipes is bounded.
      drain = setTimeout(() => settle(exitCode, signal), EXIT_DRAIN_MS);
    });
    child.on("close", (exitCode, signal) => settle(exitCode, signal));
  });
}

/** POSIX only: Windows has no process groups to signal with `kill(-pid)`. */
const GROUP_KILL = process.platform !== "win32";

/** Signal the child's whole process group, or just the child where there is none. */
function killTree(
  child: { pid?: number | undefined; kill(signal: NodeJS.Signals): boolean },
  signal: NodeJS.Signals,
): void {
  if (GROUP_KILL && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // ESRCH: the group is already gone. Fall through to the direct child,
      // which is a no-op for an exited one.
    }
  }
  child.kill(signal);
}

/**
 * Groups that may still be running, SIGKILLed if this process exits first —
 * the stand-in for the Ctrl-C a `detached` group no longer receives from the
 * terminal (`aai dev` exits through `process.exit` on SIGINT, so `exit` fires).
 * One listener for the module, installed on first use, rather than one per
 * spawn.
 *
 * A group is forgotten once it is EMPTY, not once its command settles: a
 * backgrounded job outlives the command that started it, and is exactly what
 * the terminal's Ctrl-C used to reach.
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

function trackGroup(pid: number | undefined): { settled(): void } {
  if (!GROUP_KILL || pid === undefined) return { settled: () => undefined };
  for (const id of liveGroups) if (!groupAlive(id)) liveGroups.delete(id);
  liveGroups.add(pid);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const id of liveGroups) {
        try {
          process.kill(-id, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
  }
  return {
    settled: () => {
      if (!groupAlive(pid)) liveGroups.delete(pid);
    },
  };
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
  if (result.timedOut) {
    return `${result.stdout}\n[killed by ${result.signal ?? "SIGTERM"} after ${timeoutMs}ms]`;
  }
  return result.signal ? `${result.stdout}\n[killed by ${result.signal}]` : result.stdout;
}
