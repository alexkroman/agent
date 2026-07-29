// Copyright 2026 the AAI authors. MIT license.
/**
 * sendAudioFile guards: the decode step is async, so uploads must hold their
 * own lock (no second upload, no mic start mid-upload) and abandon the send
 * when the session is reset underneath them. The audio module is mocked —
 * jsdom has no OfflineAudioContext — so these tests drive the paths around
 * the decode, not the decode itself.
 */
import { MAX_SYNC_AUDIO_SECONDS } from "@alexkroman1/aai/stt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertValidClientFrames,
  type ConstructorType,
  lastSocket,
  MockWebSocket,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import { FILE_SEND_BACKOFF_MS, MIC_SEND_MAX_BUFFERED_BYTES } from "./types.ts";

/** Resolvers for in-flight mock decodes, in call order — tests pop to release. */
const pendingDecodes: ((clip: Int16Array) => void)[] = [];

vi.mock("./audio.ts", () => ({
  decodeAudioToPcm16: vi.fn(
    (_data: ArrayBuffer, _rate: number) =>
      new Promise<Int16Array>((resolve) => {
        pendingDecodes.push(resolve);
      }),
  ),
}));

const textOnlyConfig = () => makeConfig(16_000, 24_000, "sess-upload", { audioOut: false });

/** A 10 ms clip at 16 kHz — comfortably on the one-shot (Sync API) path. */
const shortClip = () => new Int16Array(160).fill(7);

describe("sendAudioFile upload guards", () => {
  let core: SessionCore;

  beforeEach(() => {
    resetLastSocket();
    pendingDecodes.length = 0;
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocket as unknown as ConstructorType,
    });
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(textOnlyConfig());
  });

  afterEach(() => {
    core.disconnect();
  });

  function sentJson(): { type: string }[] {
    const send = lastSocket?.send as ReturnType<typeof vi.fn>;
    return send.mock.calls
      .map((c) => c[0] as unknown)
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d) as { type: string });
  }

  function binarySends(): Uint8Array[] {
    const send = lastSocket?.send as ReturnType<typeof vi.fn>;
    return send.mock.calls
      .map((c) => c[0] as unknown)
      .filter((d): d is Uint8Array => d instanceof Uint8Array);
  }

  it("a short upload frames the clip as one-shot start/bytes/end", async () => {
    const promise = core.sendAudioFile(new Blob(["x"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    pendingDecodes.pop()?.(shortClip());
    await promise;
    const types = sentJson().map((m) => m.type);
    expect(types).toContain("transcribe_file_start");
    expect(types).toContain("transcribe_file_end");
    const send = lastSocket?.send as ReturnType<typeof vi.fn>;
    const binaryBytes = send.mock.calls
      .map((c) => c[0] as unknown)
      .filter((d): d is Uint8Array => d instanceof Uint8Array)
      .reduce((n, d) => n + d.byteLength, 0);
    expect(binaryBytes).toBe(shortClip().byteLength);
    assertValidClientFrames(lastSocket);
  });

  it("a long clip skips the one-shot path and streams with trailing silence", async () => {
    const sampleRate = 16_000;
    // One sample past the Sync API cap forces the realtime streaming path.
    const clip = new Int16Array(MAX_SYNC_AUDIO_SECONDS * sampleRate + 1).fill(1);
    const promise = core.sendAudioFile(new Blob(["x"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    pendingDecodes.pop()?.(clip);
    await promise;

    // No one-shot framing on the long path.
    const types = sentJson().map((m) => m.type);
    expect(types).not.toContain("transcribe_file_start");
    expect(types).not.toContain("transcribe_file_end");

    // Clip plus one second of endpointing silence, byte for byte.
    const chunks = binarySends();
    const total = chunks.reduce((n, d) => n + d.byteLength, 0);
    expect(total).toBe((clip.length + sampleRate) * 2);
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // The trailing second is zeros (the padding), the body is the clip.
    expect(all[0]).toBe(1);
    const tail = all.subarray(total - sampleRate * 2);
    expect(tail.every((b) => b === 0)).toBe(true);
    assertValidClientFrames(lastSocket);
  });

  describe("backpressure while streaming", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reset() while parked on backpressure rejects the upload and sends no bytes", async () => {
      const socket = lastSocket;
      if (socket) socket.bufferedAmount = MIC_SEND_MAX_BUFFERED_BYTES + 1;
      const promise = core.sendAudioFile(new Blob(["x"]));
      const rejection = expect(promise).rejects.toThrow(/reset mid-send/);
      await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
      pendingDecodes.pop()?.(shortClip());

      // The start frame goes out, but the bytes park on the send queue.
      await vi.advanceTimersByTimeAsync(FILE_SEND_BACKOFF_MS * 3);
      expect(sentJson().map((m) => m.type)).toContain("transcribe_file_start");
      expect(binarySends()).toHaveLength(0);

      core.reset();
      await vi.advanceTimersByTimeAsync(FILE_SEND_BACKOFF_MS);
      await rejection;

      // The abandoned upload never sends another frame.
      await vi.advanceTimersByTimeAsync(FILE_SEND_BACKOFF_MS * 5);
      expect(binarySends()).toHaveLength(0);
      expect(sentJson().map((m) => m.type)).not.toContain("transcribe_file_end");
    });

    it("the send resumes once backpressure clears", async () => {
      const socket = lastSocket;
      if (socket) socket.bufferedAmount = MIC_SEND_MAX_BUFFERED_BYTES + 1;
      const promise = core.sendAudioFile(new Blob(["x"]));
      await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
      pendingDecodes.pop()?.(shortClip());
      await vi.advanceTimersByTimeAsync(FILE_SEND_BACKOFF_MS * 2);
      expect(binarySends()).toHaveLength(0);

      if (socket) socket.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(FILE_SEND_BACKOFF_MS);
      await promise;

      const total = binarySends().reduce((n, d) => n + d.byteLength, 0);
      expect(total).toBe(shortClip().byteLength);
      expect(sentJson().map((m) => m.type)).toContain("transcribe_file_end");
      assertValidClientFrames(socket);
    });
  });

  it("a second upload while one is decoding rejects", async () => {
    const first = core.sendAudioFile(new Blob(["a"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    await expect(core.sendAudioFile(new Blob(["b"]))).rejects.toThrow(/already in progress/);
    pendingDecodes.pop()?.(shortClip());
    await first;
    // The lock releases with the upload: a fresh one may start.
    const second = core.sendAudioFile(new Blob(["c"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    pendingDecodes.pop()?.(shortClip());
    await second;
  });

  it("startRecording is refused while an upload is in flight", async () => {
    const promise = core.sendAudioFile(new Blob(["x"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    core.startRecording();
    // The guard returned before touching the mic: no recording, no audio error
    // (the mocked audio module would have thrown loudly on the mic path).
    expect(core.getSnapshot().recording).toBe(false);
    expect(core.getSnapshot().error).toBe(null);
    pendingDecodes.pop()?.(shortClip());
    await promise;
  });

  it("a reset during the decode abandons the upload", async () => {
    const promise = core.sendAudioFile(new Blob(["x"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    core.reset();
    pendingDecodes.pop()?.(shortClip());
    await expect(promise).rejects.toThrow(/reset mid-send/);
    // Nothing from the stale clip reached the socket.
    expect(sentJson().map((m) => m.type)).not.toContain("transcribe_file_start");
  });

  it("a server-initiated reset abandons the upload", async () => {
    const promise = core.sendAudioFile(new Blob(["x"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    // The server's reset event must bump the upload epoch just like a
    // client-side reset(), or the stale clip streams into the fresh session.
    lastSocket?.simulateMessage(JSON.stringify({ type: "reset" }));
    pendingDecodes.pop()?.(shortClip());
    await expect(promise).rejects.toThrow(/reset mid-send/);
    expect(sentJson().map((m) => m.type)).not.toContain("transcribe_file_start");
  });

  it("a disconnect during the decode abandons the upload", async () => {
    const promise = core.sendAudioFile(new Blob(["x"]));
    await vi.waitFor(() => expect(pendingDecodes.length).toBe(1));
    core.disconnect();
    pendingDecodes.pop()?.(shortClip());
    await expect(promise).rejects.toThrow(/reset mid-send|connection closed/);
  });
});
