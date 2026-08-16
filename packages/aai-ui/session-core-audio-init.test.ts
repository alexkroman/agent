// Copyright 2026 the AAI authors. MIT license.
/**
 * initAudioCapture race guards: the in-flight flag must stay owned by the
 * newest init when a stale generation's init settles late, a resolved
 * VoiceIO must never orphan a previous instance (live mic tracks), and the
 * pre-init greeting replay must respect turn boundaries (barge-in). The
 * audio module is mocked so tests control exactly when each init resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "./_react-test-utils.ts";
import {
  lastSocket,
  type MockWebSocket,
  MockWebSocketConstructor,
  makeConfig,
  resetLastSocket,
} from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionCore } from "./session-core-types.ts";

type FakeVoiceIO = {
  enqueue: ReturnType<typeof vi.fn<(buf: ArrayBuffer) => void>>;
  done: () => Promise<void>;
  flush: ReturnType<typeof vi.fn<() => void>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

function makeFakeIO(done?: () => Promise<void>): FakeVoiceIO {
  const io: FakeVoiceIO = {
    enqueue: vi.fn<(buf: ArrayBuffer) => void>(),
    done: done ?? (() => Promise.resolve()),
    flush: vi.fn<() => void>(),
    close: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    async [Symbol.asyncDispose]() {
      await io.close();
    },
  };
  return io;
}

/** Resolvers for in-flight mock inits, in call order — tests pop/shift to release. */
const pendingInits: ((io: FakeVoiceIO) => void)[] = [];

const createVoiceIOMock = vi.fn(
  (_opts: unknown) =>
    new Promise<FakeVoiceIO>((resolve) => {
      pendingInits.push(resolve);
    }),
);

vi.mock("./audio.ts", () => ({
  createVoiceIO: (opts: unknown) => createVoiceIOMock(opts),
}));

describe("initAudioCapture races", () => {
  let core: SessionCore;

  beforeEach(() => {
    resetLastSocket();
    pendingInits.length = 0;
    createVoiceIOMock.mockClear();
    core = createSessionCore({
      platformUrl: "ws://localhost:3000",
      WebSocket: MockWebSocketConstructor,
    });
  });

  afterEach(() => {
    core.disconnect();
  });

  function sentJsonTypes(socket: MockWebSocket | null): string[] {
    const send = socket?.send as ReturnType<typeof vi.fn>;
    return send.mock.calls
      .map((c) => c[0] as unknown)
      .filter((d): d is string => typeof d === "string")
      .map((d) => (JSON.parse(d) as { type: string }).type);
  }

  it("a stale init settling late cannot clear a newer init's in-flight flag", async () => {
    // Gen N: init1 starts and stalls (e.g. on the mic permission prompt).
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());
    await vi.waitFor(() => expect(createVoiceIOMock).toHaveBeenCalledTimes(1));

    // Reconnect (gen N+1): init2 starts and is also pending.
    core.connect();
    const socket2 = lastSocket;
    socket2?.simulateOpen();
    socket2?.simulateMessage(makeConfig());
    await vi.waitFor(() => expect(createVoiceIOMock).toHaveBeenCalledTimes(2));

    // init1 settles: stale generation, so it closes its own io — and must
    // NOT clear the in-flight flag init2 owns.
    const io1 = makeFakeIO();
    pendingInits.shift()?.(io1);
    await vi.waitFor(() => expect(io1.close).toHaveBeenCalled());

    // With the flag intact, a third init trigger is refused while init2 is
    // still pending — no second same-generation VoiceIO, no orphaned mic.
    socket2?.simulateMessage(makeConfig());

    const io2 = makeFakeIO();
    pendingInits.shift()?.(io2);
    await vi.waitFor(() => expect(core.getSnapshot().recording).toBe(true));

    expect(createVoiceIOMock).toHaveBeenCalledTimes(2);
    expect(io2.close).not.toHaveBeenCalled();
    expect(sentJsonTypes(socket2).filter((t) => t === "audio_ready")).toHaveLength(1);
  });

  it("assigning a new voiceIO closes any previous instance", async () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());
    await vi.waitFor(() => expect(createVoiceIOMock).toHaveBeenCalledTimes(1));
    const io1 = makeFakeIO();
    pendingInits.shift()?.(io1);
    await vi.waitFor(() => expect(core.getSnapshot().recording).toBe(true));
    expect(io1.close).not.toHaveBeenCalled();

    // A second same-connection init (repeated config) must not leave io1
    // orphaned with live mic tracks when io2 takes the slot.
    lastSocket?.simulateMessage(makeConfig());
    await vi.waitFor(() => expect(createVoiceIOMock).toHaveBeenCalledTimes(2));
    const io2 = makeFakeIO();
    pendingInits.shift()?.(io2);
    await vi.waitFor(() => expect(io1.close).toHaveBeenCalled());
    expect(io2.close).not.toHaveBeenCalled();
  });

  it("the replayed greeting done does not stomp 'thinking' after a barge-in", async () => {
    core.connect();
    lastSocket?.simulateOpen();
    lastSocket?.simulateMessage(makeConfig());
    await vi.waitFor(() => expect(createVoiceIOMock).toHaveBeenCalledTimes(1));

    // Greeting audio and its audio_done arrive before init completes.
    lastSocket?.simulateMessage(new Uint8Array([1, 2, 3, 4]).buffer);
    lastSocket?.simulateMessage(JSON.stringify({ type: "audio.completed" }));

    // Init completes with a done() the test resolves later — the replayed
    // greeting drain is now in flight.
    const greetingDrain = Promise.withResolvers<void>();
    const io = makeFakeIO(() => greetingDrain.promise);
    pendingInits.shift()?.(io);
    await vi.waitFor(() => expect(core.getSnapshot().recording).toBe(true));

    // Barge-in mid-greeting commits a user turn: state moves to "thinking".
    lastSocket?.simulateMessage(
      JSON.stringify({ type: "user-transcript.committed", text: "wait" }),
    );
    expect(core.getSnapshot().state).toBe("thinking");

    // The stale greeting drain resolving late must not flip state back.
    greetingDrain.resolve();
    await tick();
    expect(core.getSnapshot().state).toBe("thinking");
  });
});
