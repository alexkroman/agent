// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for `transcodeUpload`, driven against a FAKE ffmpeg child.
 *
 * ffmpeg is not what is under test — `ffmpeg.test.ts` owns the runner, and the
 * scenario tier owns the argv against a real binary. What this composition owns
 * is the plumbing around the run: the recording is materialized ONCE and the
 * child reads that file, the standing flags are prepended, the verdict is
 * applied before the engine sees a failure, an empty output is refused rather
 * than stored, and the temp directory is gone afterwards. The child is swapped
 * in through the `ffmpegProcess.spawn` seam, as `ffmpeg.test.ts` does; the
 * store is `installStubUploads`, so what was stored is readable without going
 * back through the slot.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { FatalError } from "../sdk/step-error-classes.ts";
import { installStubUploads } from "../sdk/testing-vitest.ts";
import { ffmpegProcess, isFfmpegError } from "./_ffmpeg-spawn.ts";
import { transcodeUpload } from "./step-files-transcode.ts";

const RECORDING = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 5, 6]);
const PROBE_JSON = JSON.stringify({
  streams: [{ index: 0, codec_type: "audio", codec_name: "aac" }],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.5" },
});

/** One spawned child, as the fake saw it. */
type Spawned = { binary: string; args: string[]; sourceBytes: Uint8Array | undefined };

/**
 * A fake ffmpeg: on spawn it reads the `-i` input off the argv, writes `output`
 * to the LAST argument (the destination), and exits `code` on the next
 * macrotask. An ffprobe spawn answers `PROBE_JSON` on stdout. `hang: true`
 * exits only when the run's signal aborts, which is how a timeout is driven.
 */
function installFakeFfmpeg(
  options: { code?: number; stderr?: string; output?: Uint8Array | "none"; hang?: boolean } = {},
): Spawned[] {
  const spawned: Spawned[] = [];
  vi.spyOn(ffmpegProcess, "spawn").mockImplementation((binary, args, spawnOptions) => {
    const listeners = new Map<string, (...payload: never[]) => void>();
    const data = new Map<string, (chunk: Buffer) => void>();
    const at = args.indexOf("-i");
    const source = at === -1 ? args.at(-1) : args[at + 1];
    spawned.push({
      binary,
      args,
      sourceBytes: source && existsSync(source) ? new Uint8Array(readFileSync(source)) : undefined,
    });
    const close = (code: number | null, signal: string | null) =>
      (listeners.get("close") as ((c: number | null, s: string | null) => void) | undefined)?.(
        code,
        signal,
      );
    const finish = () => {
      if (binary === "ffprobe") {
        data.get("stdout")?.(Buffer.from(PROBE_JSON));
        return close(0, null);
      }
      if (options.stderr) data.get("stderr")?.(Buffer.from(options.stderr));
      const out = args.at(-1);
      if (out && options.output !== "none") {
        writeFileSync(out, options.output ?? new Uint8Array([7, 7, 7]));
      }
      return close(options.code ?? 0, null);
    };
    if (options.hang === true && binary !== "ffprobe") {
      spawnOptions.signal.addEventListener("abort", () => close(null, "SIGTERM"), { once: true });
    } else {
      setTimeout(finish, 0);
    }
    const stream = (name: string) => ({
      on(_event: "data", cb: (chunk: Buffer) => void) {
        data.set(name, cb);
        return this;
      },
    });
    return {
      stdout: stream("stdout"),
      stderr: stream("stderr"),
      stdin: null,
      on(event: string, cb: (...payload: never[]) => void) {
        listeners.set(event, cb);
        return this;
      },
      kill: () => undefined,
    };
  });
  return spawned;
}

const toWav = {
  args: (source: string, out: string) => ["-i", source, "-ac", "1", out],
  output: { name: "audio.wav", type: "audio/wav" },
};

describe("transcodeUpload", () => {
  test("materializes the recording, runs ffmpeg over it, and stores what it wrote", async () => {
    const uploads = installStubUploads(
      { rec: { bytes: RECORDING, name: "call.m4a", type: "audio/m4a" } },
      { writable: true },
    );
    const spawned = installFakeFfmpeg({
      output: new Uint8Array([1, 2, 3, 4, 5]),
      stderr: "size=1kB",
    });

    const out = await transcodeUpload("rec", toWav);

    // The child read the SAME bytes the store held — the one materialization.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.binary).toBe("ffmpeg");
    expect(spawned[0]?.sourceBytes).toEqual(RECORDING);
    // The standing flags are prepended; the caller spells only its own.
    expect(spawned[0]?.args.slice(0, 6)).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-nostdin",
      "-y",
    ]);
    // The source keeps the uploader's extension (ffmpeg's demuxer hint) and the
    // output takes the stored name's.
    expect(spawned[0]?.args[7]).toMatch(/\/source\.m4a$/);
    expect(spawned[0]?.args.at(-1)).toMatch(/\/output\.wav$/);
    expect(out).toEqual({
      id: "upl_stub_1",
      size: 5,
      bytes: RECORDING.length,
      ffmpegMs: expect.any(Number),
      stderr: "size=1kB",
    });
    expect(uploads.writes.map((one) => [one.name, one.type, [...one.bytes]])).toEqual([
      ["audio.wav", "audio/wav", [1, 2, 3, 4, 5]],
    ]);
  });

  test("removes the temp directory afterwards — a path never crosses the step boundary", async () => {
    installStubUploads({ rec: RECORDING }, { writable: true });
    const spawned = installFakeFfmpeg();

    await transcodeUpload("rec", toWav);

    const out = spawned[0]?.args.at(-1) ?? "";
    expect(existsSync(out)).toBe(false);
  });

  test("`probe: true` runs ffprobe over the same materialized file, once, and answers its reading", async () => {
    installStubUploads({ rec: { bytes: RECORDING, name: "call.m4a" } }, { writable: true });
    const spawned = installFakeFfmpeg();

    const out = await transcodeUpload("rec", { ...toWav, probe: true });

    expect(spawned.map((one) => one.binary)).toEqual(["ffprobe", "ffmpeg"]);
    expect(spawned[0]?.args.at(-1)).toBe(spawned[1]?.args[7]);
    expect(out.info?.durationSec).toBe(12.5);
    expect(out.info?.audio?.codec).toBe("aac");
  });

  test("leaves `info` absent rather than undefined when no probe was asked for", async () => {
    installStubUploads({ rec: RECORDING }, { writable: true });
    installFakeFfmpeg();

    expect(Object.keys(await transcodeUpload("rec", toWav))).not.toContain("info");
  });

  test("`loglevel` reaches the standing flags", async () => {
    installStubUploads({ rec: RECORDING }, { writable: true });
    const spawned = installFakeFfmpeg();

    await transcodeUpload("rec", { ...toWav, loglevel: "info" });

    expect(spawned[0]?.args.slice(1, 3)).toEqual(["-loglevel", "info"]);
  });

  test("an ffmpeg exit is FATAL and carries the log — ffmpeg read the file and refused it", async () => {
    const uploads = installStubUploads({ rec: RECORDING }, { writable: true });
    installFakeFfmpeg({
      code: 1,
      stderr: "Invalid data found when processing input",
      output: "none",
    });

    const err = await transcodeUpload("rec", toWav).catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toContain("Invalid data found");
    expect(uploads.writes).toEqual([]);
  });

  test("a zero exit that wrote NOTHING is fatal too, named by the file, and stores nothing", async () => {
    const uploads = installStubUploads(
      { rec: { bytes: RECORDING, name: "call.m4a" } },
      { writable: true },
    );
    installFakeFfmpeg({ output: new Uint8Array(0) });

    const err = await transcodeUpload("rec", toWav).catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toContain("empty audio.wav for call.m4a");
    expect(uploads.writes).toEqual([]);
  });

  test("an output ffmpeg never created is reported the same way", async () => {
    installStubUploads({ rec: RECORDING }, { writable: true });
    installFakeFfmpeg({ output: "none" });

    const err = await transcodeUpload("rec", toWav).catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toContain("wrote no audio.wav");
  });

  test("a timeout stays RETRYABLE, as ffmpeg's own error, with the argv on it", async () => {
    installStubUploads({ rec: RECORDING }, { writable: true });
    installFakeFfmpeg({ hang: true });

    const err = await transcodeUpload("rec", { ...toWav, timeoutMs: 1 }).catch((e: unknown) => e);

    expect(isFfmpegError(err)).toBe(true);
    expect(err).toMatchObject({ kind: "timeout" });
    expect(FatalError.is(err)).toBe(false);
  });

  test("refuses an upload still arriving before anything is read or spawned", async () => {
    installStubUploads({ rec: { bytes: RECORDING, complete: false } }, { writable: true });
    const spawned = installFakeFfmpeg();

    await expect(transcodeUpload("rec", toWav)).rejects.toMatchObject({
      name: "UploadIncompleteError",
    });
    expect(spawned).toEqual([]);
  });
});
