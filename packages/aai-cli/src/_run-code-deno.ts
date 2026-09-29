// Copyright 2026 the AAI authors. MIT license.
/**
 * `AAI_RUN_CODE=deno` — a `run_code` executor for `aai dev` and `aai start`
 * that runs each snippet in its own `deno` process with NO permissions.
 *
 * ## Why a separate process, and why Deno
 *
 * `run_code` evaluates code the MODEL wrote, which is code anyone who can talk
 * to the agent can influence. On the platform it runs inside the guest's Modal
 * container, which is the boundary. A self-hosted server has no container, so
 * the builtin used to refuse there outright (`RUN_CODE_REFUSAL`) rather than
 * `eval` in the host process, where it would hold the operator's env, files and
 * network. `node:vm` and a worker thread are not boundaries either. A Deno
 * process started with no `--allow-*` flag is: every file, network, env,
 * subprocess, FFI and sys call is a permission check, and `--no-prompt` makes
 * each one a hard `NotCapable` instead of a question on a terminal nobody is
 * watching. So this keeps the guarantee the refusal existed for, and is OPT-IN:
 * unset, the builtin refuses exactly as before.
 *
 * ## What the command line closes, flag by flag (measured on Deno 2.9)
 *
 * - `--no-prompt`: a permission request throws instead of asking.
 * - `--no-config`, `--no-lock`: the working directory's `deno.json` and lock
 *   file are never read, so nothing on disk can grant or map anything.
 * - `--no-remote`, `--no-npm`: no `https:`, `jsr:` or `npm:` import resolves.
 * - `--import-map` of {@link NO_LOCAL_IMPORTS_MAP}: the one gap the flags leave.
 *   **Deno loads a LOCAL module without read permission** — `import d from
 *   "/any/file.json" with { type: "json" }` printed the file's contents under
 *   `--deny-read`, from a `data:` worker as well. The map sends every `file:`
 *   URL to a remote host, which `--no-remote` then refuses, so a local file
 *   cannot be imported, statically, dynamically or from a worker.
 * - `--v8-flags=--max-old-space-size`: a heap cap, so a runaway allocation is
 *   the child's crash and not the machine's swap.
 * - `--quiet`, `--no-code-cache`: no diagnostics mixed into the answer, and no
 *   cache written for a program that will never run again.
 *
 * The code goes on STDIN (`-`) and nowhere else, so nothing the model wrote can
 * become an argument; the working directory is the filesystem root, so
 * `Deno.cwd()` names nothing of the project's.
 *
 * ## The child env is built, not inherited
 *
 * An explicit three-entry record ({@link denoRunCodeEnv}), never
 * `process.env`: the code cannot read env anyway, but the Deno runtime itself
 * would otherwise start with every secret the server holds in its environment.
 * `DENO_DIR` is set because Deno needs a cache directory and derives one from
 * `HOME` when it is not given one; nothing else is required.
 *
 * ## Bounds
 *
 * {@link DENO_RUN_CODE_TIMEOUT_MS} of wall clock, the guest's own figure, and
 * the whole process GROUP is killed at the deadline, so a `while (true) {}` ends
 * with the process rather than outliving the call. Captured output is capped at
 * {@link DENO_RUN_CODE_STDOUT_CAP_BYTES} / {@link DENO_RUN_CODE_STDERR_CAP_BYTES}
 * and a program that fills its cap is killed then, not at the deadline: the
 * answer is read by a model and nothing past the cap would be.
 *
 * @module
 */

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { Logger, RunCodeExecutor } from "@alexkroman1/aai-runtime";
import pTimeout from "p-timeout";

/** The process-env variable that opts in: `deno` is the one value it takes. */
export const RUN_CODE_ENV = "AAI_RUN_CODE";
/** The process-env variable naming the `deno` binary; else it is looked up on PATH. */
export const DENO_PATH_ENV = "AAI_DENO_PATH";

/** Wall-clock budget for one snippet — the guest's `RUN_CODE_TIMEOUT_MS`. */
export const DENO_RUN_CODE_TIMEOUT_MS = 5000;
/** What a snippet may print to stdout before it is cut off (and killed). */
export const DENO_RUN_CODE_STDOUT_CAP_BYTES = 64 * 1024;
/** What is kept of stderr: enough for an uncaught error and its first frames. */
export const DENO_RUN_CODE_STDERR_CAP_BYTES = 16 * 1024;
/** The V8 old-space cap for one snippet, in MiB. */
export const DENO_RUN_CODE_HEAP_MB = 128;
/** The oldest Deno whose permission model and flags the module doc describes. */
const MIN_DENO_MAJOR = 2;

/**
 * Every `file:` URL remapped to a host `--no-remote` refuses: the import map
 * that closes local-module loading (see the module doc). The host name is what
 * the program's error names, so it says why.
 */
const NO_LOCAL_IMPORTS_MAP =
  'data:application/json,{"imports":{"file:///":"https://local-imports-are-disabled.invalid/"}}';

/** The argv after the binary. Fixed: the code is on stdin, never in here. */
export function denoRunCodeArgs(): string[] {
  return [
    "run",
    "--quiet",
    "--no-prompt",
    "--no-config",
    "--no-lock",
    "--no-remote",
    "--no-npm",
    "--no-code-cache",
    `--import-map=${NO_LOCAL_IMPORTS_MAP}`,
    `--v8-flags=--max-old-space-size=${DENO_RUN_CODE_HEAP_MB}`,
    "-",
  ];
}

/** The child's whole environment — see "The child env is built" in the module doc. */
export function denoRunCodeEnv(): Record<string, string> {
  return {
    DENO_DIR: path.join(os.tmpdir(), "aai-run-code-deno"),
    DENO_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
  };
}

/** The part of a `ChildProcess` the executor drives — what a fake has to be. */
export interface RunCodeChild {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (err: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

/** How a snippet's process is started — `node:child_process`'s `spawn`, injectable. */
export type RunCodeSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    detached: boolean;
    stdio: ["pipe", "pipe", "pipe"];
    windowsHide: boolean;
  },
) => RunCodeChild;

const spawnDeno: RunCodeSpawn = (command, args, options) => spawn(command, [...args], options);

/** Kill `child` and anything it started: the process group, else the child. */
function killGroup(child: RunCodeChild): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // `detached` made the child a group leader, so `-pid` is its group.
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** A capped byte collector for one stream. */
function capture(cap: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let full = false;
  return {
    /** Keep what fits; `true` once the cap is reached. */
    push(chunk: Buffer): boolean {
      if (full) return true;
      const room = cap - bytes;
      chunks.push(chunk.length <= room ? chunk : chunk.subarray(0, room));
      bytes += Math.min(chunk.length, room);
      full = bytes >= cap;
      return full;
    },
    get full(): boolean {
      return full;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * The short sentence for a failed run, out of what Deno printed: its own
 * `error: Uncaught (in promise) NotCapable: …` line without the prefixes, or
 * the way the process ended.
 */
function failureMessage(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (/heap out of memory|Last few GCs/.test(stderr)) {
    return `run_code ran out of memory (the heap is capped at ${DENO_RUN_CODE_HEAP_MB} MiB)`;
  }
  const line = stderr.split("\n").find((l) => l.startsWith("error: "));
  if (line !== undefined) {
    return line.replace(/^error: /, "").replace(/^Uncaught (\(in promise\) )?/, "");
  }
  return signal === null
    ? `run_code exited with code ${code ?? "unknown"}`
    : `run_code was killed (${signal})`;
}

/** Options for {@link createDenoRunCode}; everything but `deno` is a test seam. */
export interface DenoRunCodeOptions {
  /** Absolute path of the `deno` binary. */
  deno: string;
  spawn?: RunCodeSpawn | undefined;
  kill?: ((child: RunCodeChild) => void) | undefined;
  timeoutMs?: number | undefined;
}

/**
 * The executor: one fresh zero-permission `deno` per call, code on stdin.
 *
 * Answers what the guest's executor answers — the printed output (stdout, then
 * anything written to stderr), `"Code ran successfully (no output)"` for none,
 * `{ error }` for an uncaught error, a non-zero exit or the deadline.
 */
export function createDenoRunCode(options: DenoRunCodeOptions): RunCodeExecutor {
  const start = options.spawn ?? spawnDeno;
  const kill = options.kill ?? killGroup;
  const timeoutMs = options.timeoutMs ?? DENO_RUN_CODE_TIMEOUT_MS;
  return async (code) => {
    let child: RunCodeChild;
    try {
      child = start(options.deno, denoRunCodeArgs(), {
        cwd: path.parse(os.tmpdir()).root,
        env: denoRunCodeEnv(),
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      return { error: `run_code could not start deno: ${String(err)}` };
    }
    const stdout = capture(DENO_RUN_CODE_STDOUT_CAP_BYTES);
    const stderr = capture(DENO_RUN_CODE_STDERR_CAP_BYTES);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.push(chunk)) kill(child);
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ code: exitCode, signal }));
      },
    );
    // A child that dies before reading all of stdin answers EPIPE here; its
    // exit is the answer, so the write error is not a second one.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(code);
    try {
      const { code: exitCode, signal } = await pTimeout(ended, {
        milliseconds: timeoutMs,
        message: `run_code timed out after ${timeoutMs}ms`,
      });
      if (stdout.full) {
        return `${stdout.text()}\n… (output cut at ${DENO_RUN_CODE_STDOUT_CAP_BYTES} bytes)`;
      }
      if (exitCode !== 0) return { error: failureMessage(stderr.text(), exitCode, signal) };
      const text = [stdout.text(), stderr.text()]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("\n");
      return text || "Code ran successfully (no output)";
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      kill(child);
    }
  };
}

/** What a `deno --version` probe answers: the version line, or why not. */
export type DenoProbe = (deno: string) => { version: string } | { problem: string };

const probeDeno: DenoProbe = (deno) => {
  const probe = spawnSync(deno, ["--version"], {
    encoding: "utf8",
    env: denoRunCodeEnv(),
    timeout: 10_000,
  });
  if (probe.status !== 0) return { problem: `\`${deno} --version\` did not answer` };
  const version = /deno (\d+)\.\d+\.\d+/.exec(probe.stdout ?? "");
  if (version === null) return { problem: `\`${deno} --version\` printed no Deno version` };
  if (Number(version[1]) < MIN_DENO_MAJOR) {
    return { problem: `Deno ${version[0]} is older than the ${MIN_DENO_MAJOR}.x this needs` };
  }
  return { version: version[0].replace(/^deno /, "") };
};

/** The first executable `deno` on `PATH`, or `undefined`. */
function denoOnPath(env: Record<string, string | undefined>): string | undefined {
  const names = process.platform === "win32" ? ["deno.exe"] : ["deno"];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not here; the next PATH entry.
      }
    }
  }
  return undefined;
}

/**
 * The executor `aai dev` / `aai start` hand the runtime, or `undefined` —
 * and the ONE boot line that says which.
 *
 * Read from `process.env`, not the agent's env, for `AAI_CHANNEL_OUTBOX`'s
 * reason: it configures the PROCESS, and an agent's shipped `.env` must not be
 * able to switch on code execution for itself. Unset: `undefined`, silently,
 * and `run_code` refuses as it always has. Set to anything but `deno`, or with
 * no usable binary: a warning naming why, and still `undefined` — enabling it
 * and getting a refusal must not be silent.
 */
export function resolveDenoRunCode(
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
  probe: DenoProbe = probeDeno,
): RunCodeExecutor | undefined {
  const mode = env[RUN_CODE_ENV]?.trim();
  if (!mode) return;
  if (mode !== "deno") {
    logger.warn(`${RUN_CODE_ENV} takes only "deno"; run_code keeps refusing`, { value: mode });
    return;
  }
  const configured = env[DENO_PATH_ENV]?.trim();
  const deno = configured ? path.resolve(configured) : denoOnPath(env);
  if (deno === undefined) {
    logger.warn(`${RUN_CODE_ENV}=deno but no deno is on PATH; run_code keeps refusing`, {
      fix: `install Deno 2, or set ${DENO_PATH_ENV}`,
    });
    return;
  }
  const probed = probe(deno);
  if ("problem" in probed) {
    logger.warn(`${RUN_CODE_ENV}=deno but ${probed.problem}; run_code keeps refusing`, { deno });
    return;
  }
  logger.info("run_code runs in a zero-permission Deno sandbox", {
    deno,
    version: probed.version,
    timeoutMs: DENO_RUN_CODE_TIMEOUT_MS,
  });
  return createDenoRunCode({ deno });
}
