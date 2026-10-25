// Copyright 2026 the AAI authors. MIT license.
/**
 * The leg `transcodeUpload` and `stepSpeakToUpload` share, driven through the
 * `ffmpegProcess.spawn` seam: the standing flags, the verdict, the
 * empty-output refusal, and the store.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { FatalError } from "../sdk/step-error-classes.ts";
import { installStubUploads } from "../sdk/testing-vitest.ts";
import { ffmpegProcess } from "./_ffmpeg-spawn.ts";
import { runFfmpegToUpload } from "./_ffmpeg-to-upload.ts";
import { withTempDir } from "./step-files.ts";

/** A fake ffmpeg that writes `output` to the last argument and exits `code`. */
function installFakeFfmpeg(
  options: { code?: number; output?: Uint8Array | "none"; stderr?: string } = {},
) {
  const spawned: string[][] = [];
  vi.spyOn(ffmpegProcess, "spawn").mockImplementation((_binary, args) => {
    spawned.push(args);
    const listeners = new Map<string, (...payload: never[]) => void>();
    const data = new Map<string, (chunk: Buffer) => void>();
    setTimeout(() => {
      if (options.stderr) data.get("stderr")?.(Buffer.from(options.stderr));
      const out = args.at(-1);
      if (out && options.output !== "none")
        writeFileSync(out, options.output ?? new Uint8Array([1, 2]));
      (listeners.get("close") as ((c: number | null, s: string | null) => void) | undefined)?.(
        options.code ?? 0,
        null,
      );
    }, 0);
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

const output = { name: "out.wav", type: "audio/wav" };

/** One run inside a temp dir, the argv naming its `out`. */
function run(extra: { loglevel?: string } = {}) {
  return withTempDir(async (dir) => {
    const out = join(dir, "out.wav");
    const result = await runFfmpegToUpload(["-i", "in.wav", out], {
      dir,
      out,
      output,
      label: "the source",
      inputBytes: 2048,
      ...extra,
    });
    return { ...result, outExists: existsSync(out) };
  });
}

describe("runFfmpegToUpload", () => {
  test("prepends the standing flags, stores what ffmpeg wrote, and answers the run", async () => {
    const uploads = installStubUploads({}, { writable: true });
    const spawned = installFakeFfmpeg({ output: new Uint8Array([9, 9, 9]), stderr: "size=1kB" });

    const { upload, run: ran } = await run({ loglevel: "info" });

    expect(spawned[0]?.slice(0, 6)).toEqual([
      "-hide_banner",
      "-loglevel",
      "info",
      "-nostats",
      "-nostdin",
      "-y",
    ]);
    expect(upload).toMatchObject({ name: "out.wav", type: "audio/wav", size: 3 });
    expect(ran.stderr).toBe("size=1kB");
    expect(uploads.writes.map((one) => [...one.bytes])).toEqual([[9, 9, 9]]);
  });

  test("a zero exit that wrote NOTHING is fatal, named by the file and the label, and stores nothing", async () => {
    const uploads = installStubUploads({}, { writable: true });
    installFakeFfmpeg({ output: new Uint8Array(0), stderr: "no stream" });

    const err = await run().catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toMatch(/empty out\.wav for the source \(2(\.0)? KB in\)/);
    expect(uploads.writes).toEqual([]);
  });

  test("an output never created is reported the same way", async () => {
    installStubUploads({}, { writable: true });
    installFakeFfmpeg({ output: "none" });

    const err = await run().catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toContain("wrote no out.wav for the source");
  });

  test("an exit is FATAL and carries the log", async () => {
    const uploads = installStubUploads({}, { writable: true });
    installFakeFfmpeg({ code: 1, output: "none", stderr: "Invalid data" });

    const err = await run().catch((e: unknown) => e);

    expect(err).toSatisfy(FatalError.is);
    expect((err as Error).message).toContain("Invalid data");
    expect(uploads.writes).toEqual([]);
  });
});
