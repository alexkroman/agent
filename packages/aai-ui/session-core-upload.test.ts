// Copyright 2026 the AAI authors. MIT license.
/**
 * sendAudioFile guards: the decode step is async, so uploads must hold their
 * own lock (no second upload, no mic start mid-upload) and abandon the send
 * when the session is reset underneath them. The audio module is mocked —
 * jsdom has no OfflineAudioContext — so these tests drive the paths around
 * the decode, not the decode itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConstructorType,
  lastSocket,
  MockWebSocket,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";

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
