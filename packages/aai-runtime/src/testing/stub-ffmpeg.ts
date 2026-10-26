// Copyright 2026 the AAI authors. MIT license.
/**
 * The ffmpeg toolchain, faked — so a step that spawns it runs end to end in
 * the UNIT tier, with no binary and no subprocess.
 *
 * `runFfmpeg`, `probeMedia` and `transcodeUpload` (`@alexkroman1/aai/ffmpeg`,
 * `/step-files`) all spawn through one object, `ffmpegProcess`, which the SDK
 * keeps on `/host-internal` for exactly this swap. What a spec scripts is the
 * CHILD: given the argv, what it printed and how it exited. Everything around
 * the spawn — the standing flags, the stderr tail, the timeout, the failure
 * classification, the materialize-and-store shell — is the real code, which is
 * the point: a step's own decisions are what the test reaches, and the binary
 * is the one thing it does not.
 *
 * The script may write files. An ffmpeg pass that writes its output to a path
 * is faked by a script that writes that path itself, which is how a step's
 * `stat`, `readFile` and `writeUploadFromFile` run against real bytes.
 *
 * Declared here rather than beside `installStubUploads` because the SDK's
 * `/testing/vitest` is `sdk/`, which may not reach `host/` — and this module's
 * whole subject is a host-side seam.
 *
 * @module
 */

import { type FfmpegChild, ffmpegProcess } from "@alexkroman1/aai/host-internal";
import { onTestFinished, vi } from "vitest";

/**
 * One spawn, as the fake saw it.
 *
 * @sealed
 */
export type StubFfmpegCall = {
  /** The binary the SDK resolved — `ffmpeg`, `ffprobe`, or whatever the env named. */
  readonly binary: string;
  /** The argv, exactly as the caller built it (standing flags included). */
  readonly args: readonly string[];
  /** Bytes the run handed to stdin, for an argv that reads `pipe:0`. */
  readonly stdin: Uint8Array | undefined;
};

/**
 * What the scripted child does with one spawn.
 *
 * Every field is optional: an empty reply is a child that printed nothing and
 * exited `0`.
 *
 * @input
 */
export type StubFfmpegReply = {
  /** What the child wrote to stdout — ffprobe's JSON, or a `pipe:1` output. */
  readonly stdout?: string | Uint8Array | undefined;
  /** What the child wrote to stderr — `loudnorm`'s block, an error line. */
  readonly stderr?: string | undefined;
  /** Exit code. Defaults to `0`; anything else is an `exit` failure. */
  readonly exitCode?: number | undefined;
  /** Fail the SPAWN itself with this error instead of running — `ENOENT`, say. */
  readonly spawnError?: Error | undefined;
};

/**
 * Called once per spawn, with the argv. May be async, and may write files.
 *
 * @input
 */
export type StubFfmpegScript = (
  call: StubFfmpegCall,
) => StubFfmpegReply | undefined | Promise<StubFfmpegReply | undefined>;

/**
 * The installed fake.
 *
 * @sealed
 */
export type StubFfmpeg = {
  /** Every spawn so far, in order. */
  readonly calls: StubFfmpegCall[];
};

/**
 * Route every ffmpeg-family spawn through `script`, restored when this test
 * finishes.
 *
 * The fake never times out and never honours the run's abort signal: a child
 * that hangs is not something a script can express, and the deadline
 * machinery it would exercise is the SDK's own, tested in `ffmpeg.test.ts`.
 *
 * @example
 * ```ts
 * import { probeMedia, runFfmpeg } from "@alexkroman1/aai/ffmpeg";
 * import { installStubFfmpeg } from "@alexkroman1/aai-runtime/testing/vitest";
 * import { writeFile } from "node:fs/promises";
 * import { expect, test } from "vitest";
 *
 * test("a scripted ffmpeg answers each call by its args", async () => {
 *   const ffmpeg = installStubFfmpeg(async ({ args }) => {
 *     if (args.includes("-show_streams")) {
 *       return { stdout: '{"streams":[{"codec_type":"audio"}],"format":{"duration":"1.0"}}' };
 *     }
 *     // A transcode's output is whatever the script writes at the out path.
 *     await writeFile(args.at(-1) ?? "", new Uint8Array(32_000));
 *     return {};
 *   });
 *   const info = await probeMedia("call.m4a");
 *   expect(info.durationSec).toBe(1);
 *   await runFfmpeg(["-i", "call.m4a", "out.wav"]);
 *   expect(ffmpeg.calls).toHaveLength(2);
 * });
 * ```
 *
 * @public
 */
export function installStubFfmpeg(script: StubFfmpegScript = () => undefined): StubFfmpeg {
  const calls: StubFfmpegCall[] = [];
  const spy = vi.spyOn(ffmpegProcess, "spawn").mockImplementation((binary, args, options) => {
    const child = new ScriptedChild(options.stdio[0] === "pipe");
    // On the next macrotask, so the runner has attached every listener and
    // written stdin — the same ordering a real child gives it.
    setTimeout(() => {
      const call: StubFfmpegCall = { binary, args, stdin: child.stdinBytes };
      calls.push(call);
      Promise.resolve()
        .then(() => script(call))
        .then(
          (reply) => child.finish(reply ?? {}),
          (err: unknown) => child.fail(err instanceof Error ? err : new Error(String(err))),
        );
    }, 0);
    return child;
  });
  onTestFinished(() => spy.mockRestore());
  return { calls };
}

/**
 * A child that does what its reply says and nothing else: the structural
 * `FfmpegChild`, so the SDK drives it with no cast.
 */
class ScriptedChild implements FfmpegChild {
  readonly stdout = new DataStream();
  readonly stderr = new DataStream();
  readonly stdin: FfmpegChild["stdin"];
  stdinBytes: Uint8Array | undefined;
  private onError: ((err: NodeJS.ErrnoException) => void) | undefined;
  private onClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;

  constructor(piped: boolean) {
    this.stdin = piped
      ? {
          on: () => this,
          end: (bytes: Uint8Array) => {
            this.stdinBytes = bytes;
          },
        }
      : null;
  }

  on(event: "error", cb: (err: NodeJS.ErrnoException) => void): this;
  on(event: "close", cb: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error" | "close", cb: unknown): this {
    if (event === "error") this.onError = cb as (err: NodeJS.ErrnoException) => void;
    else this.onClose = cb as (code: number | null, signal: NodeJS.Signals | null) => void;
    return this;
  }

  kill(): void {
    // A script cannot hang, so there is never anything to kill.
  }

  finish(reply: StubFfmpegReply): void {
    if (reply.spawnError) {
      this.fail(reply.spawnError);
      return;
    }
    if (reply.stdout !== undefined) this.stdout.emit(Buffer.from(reply.stdout));
    if (reply.stderr !== undefined) this.stderr.emit(Buffer.from(reply.stderr));
    this.onClose?.(reply.exitCode ?? 0, null);
  }

  fail(err: Error): void {
    this.onError?.(err);
  }
}

/** One readable, with the `data` listener the runner attaches. */
class DataStream {
  private listener: ((chunk: Buffer) => void) | undefined;

  on(_event: "data", cb: (chunk: Buffer) => void): this {
    this.listener = cb;
    return this;
  }

  emit(chunk: Buffer): void {
    this.listener?.(chunk);
  }
}
