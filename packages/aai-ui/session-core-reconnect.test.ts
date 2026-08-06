// Copyright 2026 the AAI authors. MIT license.
/**
 * Automatic-reconnection behavior over partysocket's reconnecting socket
 * (no injected WebSocket — the mock is the underlying transport, exactly as
 * in session-core-messaging.test.ts's auto-reconnect suite): retry
 * exhaustion ends the session terminally, a socket error inside the retry
 * cycle is not misreported on a later clean close, and a retry invalidates
 * an audio init still parked on getUserMedia (the generation bump) so a
 * stale VoiceIO can never double up mics or `audio_ready` frames.
 */
import ReconnectingWebSocket from "partysocket/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AudioMockContext, fakeMediaStream, installAudioMocks } from "./_react-test-utils.ts";
import { MockWebSocket, makeConfig, resetLastSocket } from "./_session-core-test-utils.ts";
import { createSessionCore } from "./session-core.ts";
import type { SessionCore } from "./session-core-types.ts";

/** Every socket partysocket constructed, in order. */
let created: MockWebSocket[] = [];

class TrackingWebSocket extends MockWebSocket {
  constructor(url: string) {
    super(url);
    created.push(this);
  }
}

/**
 * Advance fake time in small steps until partysocket constructs the next
 * socket (backoff caps at 15s), returning it. Small steps keep each new
 * socket young enough to close before partysocket's 4s connection timeout
 * fires — so every close in these tests is the one the test performs.
 */
async function waitForNextSocket(prevCount: number): Promise<MockWebSocket> {
  for (let i = 0; i < 40 && created.length === prevCount; i++) {
    await vi.advanceTimersByTimeAsync(500);
  }
  const socket = created.at(-1);
  if (created.length === prevCount || !socket) {
    throw new Error("no reconnect attempt within 20s of fake time");
  }
  return socket;
}

describe("session-core automatic reconnection (partysocket)", () => {
  let core: SessionCore;

  beforeEach(() => {
    vi.useFakeTimers();
    resetLastSocket();
    created = [];
    vi.stubGlobal("WebSocket", TrackingWebSocket);
    core = createSessionCore({ platformUrl: "ws://localhost:3000" });
  });

  afterEach(() => {
    core.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exhausting all retries ends the session terminally and stops reconnecting", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);

    // Fail every attempt: the initial connect plus 10 retries (backoff 1s
    // doubling, capped at 15s). A safety bound keeps a regression from
    // looping forever.
    for (let attempt = 0; attempt < 15 && core.getSnapshot().state === "connecting"; attempt++) {
      const socket = created.at(-1);
      socket?.simulateClose();
      if (core.getSnapshot().state !== "connecting") break; // terminal
      await waitForNextSocket(created.length);
    }

    // Terminal: never "connecting" again — disconnected (clean closes) or
    // error, but the session has given up.
    expect(["disconnected", "error"]).toContain(core.getSnapshot().state);
    // Initial socket + 9 completed retries: the close of attempt 10 is the
    // terminal one, and the terminal handler cancels partysocket's final
    // scheduled retry before it can construct a socket.
    expect(created).toHaveLength(10);

    // No further socket is ever constructed.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(created).toHaveLength(10);
    expect(["disconnected", "error"]).toContain(core.getSnapshot().state);
  });

  // The server closing an idle session is a RECLAMATION, not a fault. Retried,
  // the tab would immediately re-open the session the server just retired and
  // cycle forever — and the guest would never see zero sessions, which is
  // what its own idle self-exit waits for.
  it("does not reconnect after the server retires the session for idleness", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = created[0];
    socket?.simulateOpen();
    socket?.simulateMessage(JSON.stringify({ type: "idle_timeout" }));
    socket?.simulateClose();

    expect(core.getSnapshot().state).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(created).toHaveLength(1);

    // But the user asking for a session again works normally, and THAT
    // socket reconnects like any other.
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(2);
    created.at(-1)?.simulateClose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(created.length).toBeGreaterThan(2);
  });

  it("a socket error inside the retry cycle is not reported on a later clean close", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = created[0];
    first?.simulateOpen();

    // The transport errors: partysocket closes it and schedules a retry.
    // The error belongs to the retry cycle, not the session.
    first?.simulateError();
    expect(core.getSnapshot().state).toBe("connecting");

    // Every further attempt closes cleanly until retries are exhausted.
    for (let attempt = 0; attempt < 15 && core.getSnapshot().state === "connecting"; attempt++) {
      const socket = await waitForNextSocket(created.length);
      socket.simulateClose();
    }

    // Terminal clean close: no stale connection error from mid-cycle.
    const snap = core.getSnapshot();
    expect(snap.state).toBe("disconnected");
    expect(snap.error).toBe(null);
  });

  describe("voice reconnect with a parked audio init", () => {
    let audio: AudioMockContext & { restore: () => void };
    /** Resolvers for parked getUserMedia calls, in call order. */
    let gumResolvers: ((stream: MediaStream) => void)[] = [];
    let tracks: { stopped: boolean; stop(): void }[] = [];

    function makeStream(): MediaStream {
      const track = {
        stopped: false,
        stop() {
          this.stopped = true;
        },
      };
      tracks.push(track);
      return fakeMediaStream(track);
    }

    beforeEach(() => {
      audio = installAudioMocks();
      gumResolvers = [];
      tracks = [];
      navigator.mediaDevices.getUserMedia = () =>
        new Promise<MediaStream>((resolve) => {
          gumResolvers.push(resolve);
        });
    });

    afterEach(() => {
      audio.restore();
    });

    function audioReadyCount(socket: MockWebSocket | undefined): number {
      const calls = socket?.send.mock.calls ?? [];
      return calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          (JSON.parse(c[0] as string) as { type: string }).type === "audio_ready",
      ).length;
    }

    it("a retry invalidates an init parked on getUserMedia — no duplicate audio_ready, one live mic", async () => {
      core.connect();
      await vi.advanceTimersByTimeAsync(0);
      const first = created[0];
      first?.simulateOpen();
      first?.simulateMessage(makeConfig()); // voice config → init #1 starts

      // Init #1 reaches getUserMedia and parks there (permission prompt).
      await vi.waitFor(() => {
        expect(gumResolvers).toHaveLength(1);
      });

      // The socket drops while the prompt is still up: partysocket retries,
      // and the retry must invalidate the parked init (generation bump).
      first?.simulateClose();
      expect(core.getSnapshot().state).toBe("connecting");

      const second = await waitForNextSocket(1);
      second.simulateOpen();
      second.simulateMessage(makeConfig()); // reconnect config → init #2

      await vi.waitFor(() => {
        expect(gumResolvers).toHaveLength(2);
      });

      // The STALE init's getUserMedia resolves first. Its VoiceIO must be
      // discarded: mic stopped, and no audio_ready sent for it.
      gumResolvers[0]?.(makeStream());
      await vi.waitFor(() => {
        expect(tracks[0]?.stopped).toBe(true);
      });
      expect(audioReadyCount(second)).toBe(0);
      expect(core.getSnapshot().recording).toBe(false);

      // The retried connection's own init completes normally.
      gumResolvers[1]?.(makeStream());
      await vi.waitFor(() => {
        expect(core.getSnapshot().recording).toBe(true);
      });

      // Exactly one audio_ready per completed init — none from the stale
      // generation — and exactly one live mic.
      expect(audioReadyCount(first)).toBe(0);
      expect(audioReadyCount(second)).toBe(1);
      expect(tracks[0]?.stopped).toBe(true);
      expect(tracks[1]?.stopped).toBe(false);
    });
  });
});

// --- partysocket internals guard ---

describe("partysocket internals used by reconnectPending", () => {
  // reconnectPending() (session-core-reconnect.ts) reads
  // `socket.shouldReconnect` and `socket.retryCount` — partysocket
  // implementation details, not documented API. session-core's close handler
  // branches on it, so if a partysocket bump renames or retypes either field,
  // every transient close would silently become a terminal error. This pins
  // those undocumented internals on a real instance; a rename fails here (and
  // at typecheck) instead of in production.
  it("exposes shouldReconnect and retryCount with the expected types", () => {
    // startClosed keeps the constructor from dialing anything.
    const socket = new ReconnectingWebSocket("ws://localhost:1", undefined, {
      startClosed: true,
    });
    try {
      expect(typeof socket.shouldReconnect).toBe("boolean");
      expect(typeof socket.retryCount).toBe("number");
      expect(socket.retryCount).toBe(0);
    } finally {
      socket.close();
    }
  });
});
