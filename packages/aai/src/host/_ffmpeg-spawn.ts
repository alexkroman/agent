// Copyright 2026 the AAI authors. MIT license.
/**
 * The child-process half of `ffmpeg.ts`: which binary to spawn, and the four
 * properties every spawn of it has.
 *
 * Split out because it is the half with no ffmpeg VOCABULARY in it — no argv,
 * no codec names, no notion of what a WAV is. What lives here is the policy
 * `ffmpeg.ts`'s module doc argues for at length and every wrapper on npm gets
 * wrong: bounded output, an abortable deadline, a failure that says which kind
 * it is, and a missing binary that names its remedy. Read that doc first; this
 * module implements its numbered list.
 *
 * Internal (`_`-prefixed) because the seam is not a promise: the error class,
 * its `kind`, and the option and result shapes are all published through
 * `@alexkroman1/aai/ffmpeg`, which is the only import path a caller has.
 */

// Spawning a child is what this module IS, and the ban's stated reason ("not
// available in Firecracker guest VMs") does not describe where this runs — a
// Modal guest is a container, and `aai-guest/studio-spawn.ts` already spawns
// npm, bash and the bundler inside one on every studio build. The suppression
// is scoped to this LINE rather than lifted for the file, so the other eight
// restricted modules stay banned here.
// biome-ignore lint/style/noRestrictedImports: see above.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { omitUndefined } from "../sdk/omit-undefined.ts";

/** Overrides the `ffmpeg` binary this module spawns. */
export const FFMPEG_PATH_ENV = "AAI_FFMPEG_PATH";

/** Overrides the `ffprobe` binary this module spawns. */
export const FFPROBE_PATH_ENV = "AAI_FFPROBE_PATH";

/**
 * How long one ffmpeg run may take before it is killed.
 *
 * Ten minutes, which is long: transcoding an hour of audio is minutes of real
 * work, and a step that has already read its input off object storage should
 * not lose it to a budget tighter than the job. It is a BACKSTOP against a run
 * that will never finish, not a service-level target — a caller with a tighter
 * one passes `timeoutMs`, and a workflow step has its own budget above this.
 */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 10 * 60_000;

/**
 * How much of ffmpeg's log is kept, from the END.
 *
 * ffmpeg writes progress to stderr — one line per statistics interval for the
 * whole run — and the reason it failed is the last thing in there. So a tail is
 * not a compromise here, it is the informative part; a head would be the
 * banner and the input's stream list every time.
 *
 * CHARACTERS, not bytes, and the name says so because the two differ exactly
 * where it matters: a log naming `Café.m4a` is UTF-8, and a byte-sliced tail
 * can cut a character in half. The stream is decoded with a `StringDecoder`
 * for the same reason — a chunk boundary lands mid-character often enough that
 * `chunk.toString()` per chunk produces a replacement character in the one
 * message a human reads.
 */
export const FFMPEG_STDERR_TAIL_CHARS = 4000;

/**
 * How many bytes a run may write to stdout before it is killed.
 *
 * 64 MiB. Only piped output counts against it (`pipe:1`), and it exists because
 * the alternative is an OOM: a guest reserves ~1 GiB, and captured output is
 * held whole in the guest's heap on its way to being returned. Raise it
 * deliberately for a big in-memory conversion, or write to a file and capture
 * nothing.
 */
export const DEFAULT_MAX_FFMPEG_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Which way a run failed — see {@link FfmpegError}. */
export type FfmpegFailureKind =
  /** The binary ran and exited non-zero. Almost always the input, not the run. */
  | "exit"
  /** Killed at `timeoutMs`. */
  | "timeout"
  /** Killed because the caller's `signal` aborted. */
  | "aborted"
  /** The binary is not installed, or `AAI_FFMPEG_PATH` points at nothing. */
  | "missing-binary"
  /** Piped output passed `maxOutputBytes`; the child was killed. */
  | "output-too-large";

/**
 * A failed ffmpeg run, with the diagnosis attached.
 *
 * `stderr` is the tail of ffmpeg's own log, which is where the reason is
 * ("Invalid data found when processing input", "Output file #0 does not contain
 * any stream"). {@link kind} is what a caller BRANCHES on — see the module doc's
 * point 3 for why a workflow step must, rather than retrying a corrupt file
 * until its attempts run out.
 */
export class FfmpegError extends Error {
  readonly kind: FfmpegFailureKind;
  /** Exit status, or `null` when the child was killed by a signal. */
  readonly exitCode: number | null;
  /** The signal that killed it, when one did. */
  readonly signal: NodeJS.Signals | null;
  /** The tail of the child's stderr — ffmpeg's log. */
  readonly stderr: string;
  /** The binary that was spawned, and the arguments it got. */
  readonly binary: string;
  readonly argv: readonly string[];

  constructor(options: {
    kind: FfmpegFailureKind;
    message: string;
    binary: string;
    argv: readonly string[];
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    cause?: unknown;
  }) {
    super(options.message, omitUndefined({ cause: options.cause }));
    this.name = "FfmpegError";
    this.kind = options.kind;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stderr = options.stderr ?? "";
    this.binary = options.binary;
    this.argv = options.argv;
  }
}

/** Narrow an unknown catch to a failed ffmpeg run. */
export function isFfmpegError(value: unknown): value is FfmpegError {
  return value instanceof FfmpegError;
}

export type FfmpegRunOptions = {
  /** The binary to spawn. Defaults to `AAI_FFMPEG_PATH`, `FFMPEG_PATH`, then `ffmpeg`. */
  binary?: string;
  /** Working directory for the child, so relative paths in `args` resolve. */
  cwd?: string;
  /** Bytes to write to the child's stdin — read them in the argv as `pipe:0`. */
  stdin?: Uint8Array;
  /** Kill the run when this aborts. Combined with `timeoutMs`, not replaced by it. */
  signal?: AbortSignal;
  /** Wall-clock budget. Defaults to 10 minutes (`DEFAULT_FFMPEG_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Cap on captured stdout. Defaults to 64 MiB (`DEFAULT_MAX_FFMPEG_OUTPUT_BYTES`). */
  maxOutputBytes?: number;
};

export type FfmpegRunResult = {
  /** Whatever the child wrote to stdout — empty for a run that wrote to a file. */
  stdout: Uint8Array;
  /** The tail of ffmpeg's log, on SUCCESS too: it carries the encode summary. */
  stderr: string;
  /** Wall-clock milliseconds the child ran for. */
  durationMs: number;
};

/**
 * Which binary to spawn: the explicit override, then `AAI_FFMPEG_PATH`, then
 * the ecosystem-conventional `FFMPEG_PATH`, then the bare name on `PATH`.
 *
 * The conventional name is honored because it is what a developer's machine
 * already sets — every ffmpeg wrapper on npm reads it — and this module's whole
 * job under `aai dev` is to find the ffmpeg that is already installed. An
 * `AAI_`-prefixed variable still wins, so an operator can pin one binary for
 * this SDK without disturbing whatever else on the box reads the other.
 */
export function resolveBinary(
  aaiEnv: string,
  conventionalEnv: string,
  fallback: string,
  override: string | undefined,
): string {
  const candidates = [override, process.env[aaiEnv], process.env[conventionalEnv]];
  return candidates.map((value) => value?.trim()).find((value) => value) ?? fallback;
}

/**
 * Spawn one ffmpeg-family binary under the four properties the module doc
 * states, and settle on the first of `error` or `close`.
 *
 * Both fire for a spawn failure and for an abort (verified: ENOENT emits
 * `error` then `close(-2, null)`), so the handler that fires FIRST has to be
 * the one that decides — a `close` believed over an `error` would report a
 * missing binary as exit code -2.
 */
export function spawnFfmpeg(
  binary: string,
  args: readonly string[],
  options: FfmpegRunOptions & { installHint: string; pathEnv: string },
): Promise<FfmpegRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_FFMPEG_OUTPUT_BYTES;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const startedAt = performance.now();

  return new Promise<FfmpegRunResult>((resolve, reject) => {
    const child = spawn(binary, [...args], {
      ...omitUndefined({ cwd: options.cwd }),
      signal,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const fail = (opt: Omit<ConstructorParameters<typeof FfmpegError>[0], "binary" | "argv">) =>
      reject(new FfmpegError({ ...opt, binary, argv: args }));

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrTail = createTailBuffer(FFMPEG_STDERR_TAIL_CHARS);
    let overflowed = false;

    // Optional-chained rather than asserted: `stdio` is dynamic, so the types
    // cannot see that both are pipes here. Skipping the listener is the only
    // sound behaviour for a stream that does not exist, and it costs nothing —
    // the outcome still comes from the child's own exit.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        // Kill rather than keep reading: the cap exists because the guest's
        // heap is the thing that runs out, and it does so while we buffer.
        overflowed = true;
        chunks.length = 0;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    const decoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail.push(decoder.write(chunk));
    });

    if (options.stdin !== undefined && child.stdin) {
      // EPIPE is ROUTINE, not an error: ffmpeg exits as soon as it has what it
      // needs (`-t 5` of a long input, a bad header), and an unhandled `error`
      // on this stream would take the process down with it. The child's own
      // exit is the outcome that matters, so this one is swallowed.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.stdin);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        return fail({
          kind: "missing-binary",
          message:
            `${binary} is not installed. A deployed agent's sandbox has it; under \`aai dev\` ` +
            `install ${options.installHint} locally (\`brew install ffmpeg\`, ` +
            "`apt-get install ffmpeg`) or point " +
            `${options.pathEnv} at a binary.`,
          cause: err,
        });
      }
      if (err.name === "AbortError") return fail(abortFailure(deadline, timeoutMs, binary));
      return fail({
        kind: "exit",
        message: `${binary} failed to run: ${err.message}`,
        cause: err,
      });
    });

    child.on("close", (exitCode, closeSignal) => {
      const durationMs = performance.now() - startedAt;
      if (overflowed) {
        return fail({
          kind: "output-too-large",
          message:
            `${binary} wrote more than ${maxOutputBytes} bytes to stdout and was killed — ` +
            "raise `maxOutputBytes`, or write to a file instead of `pipe:1`.",
          stderr: stderrTail.text(),
        });
      }
      // A ZERO exit outranks the abort check, and the order is the fix for a
      // real race: a caller that aborts in the window between the child exiting
      // successfully and `close` firing would otherwise have its finished work
      // reported as `aborted`. Nothing killed by the signal exits 0, so the
      // reverse mistake is not available. Overflow stays FIRST — the buffer was
      // dropped, so there is no output to resolve with.
      if (exitCode === 0) {
        return resolve({ stdout: Buffer.concat(chunks), stderr: stderrTail.text(), durationMs });
      }
      const stderr = stderrTail.text();
      if (signal.aborted) return fail({ ...abortFailure(deadline, timeoutMs, binary), stderr });
      return fail({
        kind: "exit",
        message:
          `${binary} exited ${closeSignal ? `on ${closeSignal}` : `with code ${exitCode}`}` +
          `${stderr ? `: ${stderr}` : ""}`,
        exitCode,
        signal: closeSignal,
        stderr,
      });
    });
  });
}

/**
 * Which of the two reasons a run was killed — the DEADLINE's own signal is the
 * discriminator, so a caller's abort during the last second of a ten-minute
 * budget is still reported as an abort.
 */
function abortFailure(
  deadline: AbortSignal,
  timeoutMs: number,
  binary: string,
): { kind: FfmpegFailureKind; message: string } {
  return deadline.aborted
    ? { kind: "timeout", message: `${binary} exceeded ${timeoutMs}ms and was killed` }
    : { kind: "aborted", message: `${binary} was aborted by the caller` };
}

/**
 * The last `cap` characters of a stream, joined once at the end.
 *
 * This was `text = keepTail(text + chunk, cap)` on every `data` event, which
 * allocates the whole 4000-character tail plus the chunk, slices it back down,
 * and prefixes the marker — three strings per event, all but the last thrown
 * away. `runFfmpeg` takes arbitrary argv and default ffmpeg writes a progress
 * line about twice a second, so a two-hour transcode churned well over 100 MB
 * of transient strings to produce a 4 KB result.
 *
 * Whole chunks are dropped from the front only while the remainder still covers
 * the cap, so memory is bounded by `cap` plus one chunk and the elision marker
 * is applied once, at the read.
 */
function createTailBuffer(cap: number): { push(text: string): void; text(): string } {
  const parts: string[] = [];
  let length = 0;
  return {
    push(text: string): void {
      if (text === "") return;
      parts.push(text);
      length += text.length;
      while (parts.length > 1 && length - (parts[0] as string).length >= cap) {
        length -= (parts.shift() as string).length;
      }
    },
    text(): string {
      const joined = parts.join("");
      return joined.length > cap ? `…${joined.slice(-cap)}` : joined;
    },
  };
}
