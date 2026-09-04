// Copyright 2026 the AAI authors. MIT license.
import { createLogBuffer } from "@alexkroman1/aai-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CapturedStreams,
  captureGuestOutput,
  guestLogBuffer,
  installLogCapture,
  parseLogQuery,
  resetGuestLogBuffer,
} from "./harness-logs.ts";

/** A pair of fake streams that record what reached the real writer. */
function fakeStreams(): { streams: CapturedStreams; wrote: string[] } {
  const wrote: string[] = [];
  const make = (name: string) => ({
    write: (chunk: string | Uint8Array) => {
      wrote.push(`${name}:${typeof chunk === "string" ? chunk : "<bytes>"}`);
      return true;
    },
  });
  return { streams: { stdout: make("out"), stderr: make("err") }, wrote };
}

afterEach(() => {
  resetGuestLogBuffer();
});

describe("installLogCapture", () => {
  test("captures both streams while still writing through", () => {
    const buffer = createLogBuffer();
    const { streams, wrote } = fakeStreams();
    installLogCapture(buffer, streams);

    streams.stdout.write("hello\n");
    streams.stderr.write("boom\n");

    expect(buffer.read().lines).toEqual([
      expect.objectContaining({ stream: "stdout", text: "hello" }),
      expect.objectContaining({ stream: "stderr", text: "boom" }),
    ]);
    expect(wrote).toEqual(["out:hello\n", "err:boom\n"]);
  });

  test("decodes a byte chunk", () => {
    const buffer = createLogBuffer();
    const { streams } = fakeStreams();
    installLogCapture(buffer, streams);

    streams.stdout.write(new TextEncoder().encode("bytes\n"));

    expect(buffer.read().lines[0]?.text).toBe("bytes");
  });

  test("forwards a completion callback passed in the second position", () => {
    const buffer = createLogBuffer();
    const seen: unknown[][] = [];
    const streams: CapturedStreams = {
      stdout: {
        write: (...args: unknown[]) => {
          seen.push(args);
          return true;
        },
      },
      stderr: { write: () => true },
    };
    installLogCapture(buffer, streams);

    const cb = vi.fn();
    streams.stdout.write("x\n", cb);

    // Node's two-arg overload: the callback must not land in the encoding slot,
    // or the writer never learns the write drained.
    expect(seen).toEqual([["x\n", cb]]);
  });

  test("forwards an encoding and a callback passed in the three-arg shape", () => {
    const buffer = createLogBuffer();
    const seen: unknown[][] = [];
    const streams: CapturedStreams = {
      stdout: {
        write: (...args: unknown[]) => {
          seen.push(args);
          return true;
        },
      },
      stderr: { write: () => true },
    };
    installLogCapture(buffer, streams);

    const cb = vi.fn();
    streams.stdout.write("x\n", "utf8", cb);

    expect(seen).toEqual([["x\n", "utf8", cb]]);
  });

  test("returns the underlying stream's backpressure answer", () => {
    const buffer = createLogBuffer();
    const streams: CapturedStreams = {
      stdout: { write: () => false },
      stderr: { write: () => true },
    };
    installLogCapture(buffer, streams);

    expect(streams.stdout.write("x\n")).toBe(false);
  });

  test("a capture failure never breaks the process's own output", () => {
    const buffer = createLogBuffer();
    vi.spyOn(buffer, "append").mockImplementation(() => {
      throw new Error("buffer exploded");
    });
    const { streams, wrote } = fakeStreams();
    installLogCapture(buffer, streams);

    expect(() => streams.stdout.write("still printed\n")).not.toThrow();
    expect(wrote).toEqual(["out:still printed\n"]);
  });

  test("the returned undo restores the original writers", () => {
    const buffer = createLogBuffer();
    const { streams, wrote } = fakeStreams();
    const restore = installLogCapture(buffer, streams);

    restore();
    streams.stdout.write("after\n");

    expect(buffer.read().lines).toEqual([]);
    expect(wrote).toEqual(["out:after\n"]);
  });
});

describe("guestLogBuffer", () => {
  test("is one buffer per process", () => {
    expect(guestLogBuffer()).toBe(guestLogBuffer());
  });

  test("captureGuestOutput fills the shared buffer", () => {
    const { streams } = fakeStreams();
    const restore = captureGuestOutput(streams);
    streams.stdout.write("shared\n");
    restore();

    expect(guestLogBuffer().read().lines[0]?.text).toBe("shared");
  });
});

describe("parseLogQuery", () => {
  test("reads a cursor and a limit", () => {
    expect(parseLogQuery(new URLSearchParams("after=12&limit=5"))).toEqual({
      after: 12,
      limit: 5,
    });
  });

  test("an absent cursor reads from the oldest line held", () => {
    expect(parseLogQuery(new URLSearchParams())).toEqual({ after: -1, limit: undefined });
  });

  test.each([
    ["after=nope", -1],
    ["after=-3", -1],
    ["after=1.5", -1],
    ["after=0", 0],
  ])("tolerates %s", (query, after) => {
    expect(parseLogQuery(new URLSearchParams(query)).after).toBe(after);
  });

  test.each(["limit=0", "limit=-1", "limit=abc"])("drops a nonsense %s", (query) => {
    expect(parseLogQuery(new URLSearchParams(query)).limit).toBeUndefined();
  });
});
