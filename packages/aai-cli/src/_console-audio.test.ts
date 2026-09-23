// Copyright 2026 the AAI authors. MIT license.
/**
 * The SoX devices, with `spawn` faked — the command lines, the flush-by-respawn
 * and the ENOENT translation are what this module decides; SoX itself is not
 * under test and is not installed in CI.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

const children: { cmd: string; args: string[]; child: FakeChild }[] = [];

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      exitCode: null,
      killed: false,
    }) as FakeChild;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    children.push({ cmd, args, child });
    return child;
  }),
}));

const { missingSoxMessage, soxAudio } = await import("./_console-audio.ts");

beforeEach(() => {
  children.length = 0;
});

describe("soxAudio", () => {
  test("records raw PCM16LE mono at the session's input rate", () => {
    soxAudio.startCapture(16_000, vi.fn(), vi.fn());
    expect(children[0]?.cmd).toBe("rec");
    expect(children[0]?.args).toEqual([
      "-q",
      "-t",
      "raw",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-c",
      "1",
      "-L",
      "-r",
      "16000",
      "-",
    ]);
  });

  test("delivers what the microphone writes, and stop kills it", () => {
    const onChunk = vi.fn();
    const capture = soxAudio.startCapture(16_000, onChunk, vi.fn());
    const rec = children[0]?.child;
    rec?.stdout.emit("data", Buffer.from([1, 2, 3, 4]));
    expect(onChunk).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]));

    capture.stop();
    expect(rec?.kill).toHaveBeenCalled();
  });

  test("a missing binary is reported as the install instruction, not ENOENT", () => {
    const onError = vi.fn();
    soxAudio.startCapture(16_000, vi.fn(), onError);
    children[0]?.child.emit(
      "error",
      Object.assign(new Error("spawn rec ENOENT"), { code: "ENOENT" }),
    );
    expect(onError).toHaveBeenCalledWith(new Error(missingSoxMessage("rec")));
  });

  test("a microphone that dies on its own is reported; one we stopped is not", () => {
    const onError = vi.fn();
    const capture = soxAudio.startCapture(16_000, vi.fn(), onError);
    children[0]?.child.emit("exit", 2);
    expect(onError).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const again = soxAudio.startCapture(16_000, vi.fn(), second);
    again.stop();
    children[1]?.child.emit("exit", 1);
    expect(second).not.toHaveBeenCalled();
    capture.stop();
  });

  test("a speaker that dies on its own is reported; one we flushed or stopped is not", () => {
    const onError = vi.fn();
    const player = soxAudio.startPlayback(24_000, onError);
    player.flush();
    children[0]?.child.emit("exit", null);
    expect(onError).not.toHaveBeenCalled();

    children[1]?.child.emit("exit", 1);
    expect(onError).toHaveBeenCalledWith(new Error("the speaker process exited with code 1"));

    const quiet = vi.fn();
    const stopped = soxAudio.startPlayback(24_000, quiet);
    stopped.stop();
    children[2]?.child.emit("exit", null);
    expect(quiet).not.toHaveBeenCalled();
  });

  test("playback writes to `play`, and flush replaces the process", () => {
    const player = soxAudio.startPlayback(24_000, vi.fn());
    const first = children[0];
    expect(first?.cmd).toBe("play");
    expect(first?.args).toContain("24000");

    const write = vi.spyOn(first?.child.stdin as PassThrough, "write");
    player.write(new Uint8Array([9, 9]));
    expect(write).toHaveBeenCalled();

    player.flush();
    expect(first?.child.kill).toHaveBeenCalled();
    expect(children).toHaveLength(2);
    expect(children[1]?.cmd).toBe("play");

    player.stop();
    expect(children[1]?.child.kill).toHaveBeenCalled();
    player.write(new Uint8Array([1]));
    player.flush();
    expect(children).toHaveLength(2);
  });
});
