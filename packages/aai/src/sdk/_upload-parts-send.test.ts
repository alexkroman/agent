// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import type { Claimer } from "./_upload-claims.ts";
import type { Part } from "./_upload-parts-plan.ts";
import {
  createPartSender,
  partOptions,
  type SendPart,
  sendEveryPart,
} from "./_upload-parts-send.ts";

const FIRST: Part = { index: 0, start: 0, end: 4 };
const SECOND: Part = { index: 1, start: 4, end: 8 };
const PARTS: Part[] = [FIRST, SECOND];

describe("sendEveryPart", () => {
  test("sends every missing part", async () => {
    const sent: number[] = [];
    await sendEveryPart({
      missing: PARTS,
      width: 2,
      sendPart: async (part) => {
        sent.push(part.index);
      },
      failed: new AbortController(),
    });
    expect(sent.sort((a, b) => a - b)).toEqual([0, 1]);
  });

  test("aborts the in-flight siblings on the first refusal, and raises THAT refusal", async () => {
    const failed = new AbortController();
    const refusal = new Error("part refused");
    const run = sendEveryPart({
      missing: PARTS,
      width: 2,
      sendPart: async (part) => {
        if (part.index === 1) throw refusal;
        // A sibling still on the wire: it fails only because it was aborted.
        await new Promise<void>((resolve) =>
          failed.signal.addEventListener("abort", () => resolve()),
        );
        throw new Error("aborted");
      },
      failed,
    });
    await expect(run).rejects.toBe(refusal);
    expect(failed.signal.reason).toBe(refusal);
  });
});

/** A part sender over a recording `send`, answering `status` for every request. */
function senderOver(status: number, bytesBase?: string) {
  const send = vi.fn<SendPart>(async () => new Response(null, { status }));
  const report = vi.fn<(index: number, bytes: number) => void>();
  const claimer: Claimer = { landed: vi.fn(), drain: async () => undefined };
  const sendPart = createPartSender({
    req: {
      id: "upl 1",
      type: "audio/wav",
      file: new Uint8Array(8),
      send,
      fail: async (res) => new Error(`refused ${res.status}`),
      headers: { authorization: "Bearer t" },
    },
    bytesBase,
    uploads: "https://agents.example/a/uploads/upl_1",
    options: {},
    attempts: 1,
    signal: new AbortController().signal,
    report,
    claimer,
  });
  return { sendPart, send, report, claimer };
}

describe("createPartSender", () => {
  test("PUTs a part to the agent with its auth headers, then reports its bytes", async () => {
    const { sendPart, send, report, claimer } = senderOver(204);
    await sendPart({ index: 1, start: 4, end: 8 });
    const [method, url, headers, body] = send.mock.calls[0] ?? [];
    expect(method).toBe("PUT");
    expect(url).toBe("https://agents.example/a/uploads/upl_1/parts?offset=4");
    expect(headers).toEqual({ authorization: "Bearer t", "Content-Type": "audio/wav" });
    expect(body).toBeInstanceOf(Uint8Array);
    expect(report.mock.calls).toEqual([
      [1, 0],
      [1, 4],
    ]);
    // Only the direct path has a claim to make.
    expect(claimer.landed).not.toHaveBeenCalled();
  });

  test("on the direct path, sends NO auth header and hands the landed part to the claimer", async () => {
    const { sendPart, send, claimer } = senderOver(200, "https://bytes.example/b");
    await sendPart({ index: 0, start: 0, end: 4 });
    const [, url, headers] = send.mock.calls[0] ?? [];
    expect(url).toBe("https://bytes.example/b/upl%201/0");
    expect(headers).toEqual({ "Content-Type": "audio/wav" });
    expect(claimer.landed).toHaveBeenCalledWith(0);
  });

  test("throws the caller's error for a refused part", async () => {
    const { sendPart, report } = senderOver(413);
    await expect(sendPart({ index: 0, start: 0, end: 4 })).rejects.toThrow("refused 413");
    expect(report).not.toHaveBeenCalledWith(0, 4);
  });
});

describe("partOptions", () => {
  test("re-keys progress to the part's index, and carries the signal", () => {
    const report = vi.fn<(index: number, loaded: number) => void>();
    const signal = new AbortController().signal;
    const options = partOptions({ signal, onProgress: () => undefined }, SECOND, report);
    expect(options.signal).toBe(signal);
    options.onProgress?.({ loaded: 3, total: 4, fraction: 0.75 });
    expect(report).toHaveBeenCalledWith(1, 3);
  });

  test("adds no progress callback when the caller asked for none", () => {
    expect(partOptions(undefined, FIRST, vi.fn())).toEqual({});
  });
});
