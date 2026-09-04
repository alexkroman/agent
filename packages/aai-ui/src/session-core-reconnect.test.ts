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
import {
  type AudioMockContext,
  type FakeTrack,
  fakeMediaStream,
  fakeTrack,
  installAudioMocks,
} from "./_react-test-utils.ts";
import { MockWebSocket, makeConfig, resetLastSocket } from "./_session-core-test-utils.ts";
import { createBrowserSession } from "./session-core.ts";
import type { BrowserSession } from "./session-core-types.ts";

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
  let core: BrowserSession;

  beforeEach(() => {
    vi.useFakeTimers();
    resetLastSocket();
    created = [];
    vi.stubGlobal("WebSocket", TrackingWebSocket);
    core = createBrowserSession({ platformUrl: "ws://localhost:3000" });
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
    socket?.simulateMessage(JSON.stringify({ type: "session.timed-out" }));
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

  // A FATAL error is the server saying this session cannot work. Retried, the
  // ladder runs in full while the page says CONNECTING, and the one sentence
  // that says what to fix — the server writes a good one — lands ~110 seconds
  // and 10 socket opens later, when partysocket happens to run out of retries.
  // Measured in Chromium against a `workflowApp()` under `aai dev`.
  it("does not reconnect after a FATAL error, and keeps the server's message", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = created[0];
    socket?.simulateOpen();
    socket?.simulateMessage(makeConfig());
    socket?.simulateMessage(
      JSON.stringify({
        type: "error.reported",
        code: "protocol",
        message: "this agent serves a static page, not voice sessions",
        fatal: true,
      }),
    );
    socket?.simulateClose();

    // The error the server wrote, on screen NOW rather than after the ladder.
    expect(core.getSnapshot().state).toBe("error");
    expect(core.getSnapshot().error?.message).toContain("static page");

    // And no eleventh chance: on the platform each attempt re-brokers, so a
    // refusal retried ten times is ten calls that can boot a sandbox.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(created).toHaveLength(1);
    expect(core.getSnapshot().state).toBe("error");
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
    let tracks: FakeTrack[] = [];

    function makeStream(): MediaStream {
      const track = fakeTrack();
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

// A completed WebSocket handshake is not a session. The server builds the
// session synchronously from its own upgrade callback and sends `config` at
// zero RTT, so an open socket with nothing on it means the peer is not a
// healthy agent server — a tunnel answering the 101 while the guest behind it
// is wedged. partysocket cannot see this: its connectionTimeout is cleared
// the instant `open` fires. Untreated, the session reached "ready" — the same
// live indicator the UI paints for "listening" — and stayed there forever,
// with no mic (no `config` means no initAudioCapture), no error and no retry.
describe("session-core handshake deadline", () => {
  let core: BrowserSession;
  let audio: ReturnType<typeof installAudioMocks>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetLastSocket();
    created = [];
    // The healthy case below receives a real `config`, which starts the audio
    // path — without the mocks it would fail on getUserMedia and error for a
    // reason that has nothing to do with the handshake.
    audio = installAudioMocks();
    vi.stubGlobal("WebSocket", TrackingWebSocket);
    core = createBrowserSession({ platformUrl: "ws://localhost:3000" });
  });

  afterEach(() => {
    core.disconnect();
    audio.restore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("re-dials a peer that opens the socket and never sends config", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.simulateOpen();
    expect(core.getSnapshot().state).toBe("ready");

    // Nothing arrives. The deadline turns an apparently-healthy socket into a
    // failed attempt — the sandbox behind the endpoint may have been
    // replaced, and the next attempt re-brokers.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(core.getSnapshot().state).toBe("connecting");
    const socket = await waitForNextSocket(1);
    // `waitForNextSocket` throws when no attempt arrives, so `toBeDefined()`
    // here was unreachable as a failure while reading as if the re-dial were
    // being verified. What the re-dial owes is a SECOND, DISTINCT socket: the
    // URL provider is re-evaluated per attempt, which is what lands the next
    // one on a replacement sandbox rather than the wedged peer.
    expect(created).toHaveLength(2);
    expect(socket).not.toBe(created[0]);
  });

  it("gives up with a real error rather than re-dialing a wedged peer forever", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4 && core.getSnapshot().state !== "error"; i++) {
      created.at(-1)?.simulateOpen();
      await vi.advanceTimersByTimeAsync(10_000);
      if (core.getSnapshot().state === "error") break;
      await waitForNextSocket(created.length);
    }

    expect(core.getSnapshot().state).toBe("error");
    expect(core.getSnapshot().error?.code).toBe("connection");
    // Bounded: forceReconnect restarts partysocket's own budget, so without a
    // cap of our own a wedged peer would be re-dialed every ~10s forever.
    const settled = created.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(created).toHaveLength(settled);
  });

  it("the budget is CONSECUTIVE — a completed handshake between timeouts spends nothing", async () => {
    // One guard covers a whole connect(), partysocket's retries included, so a
    // count that survived a successful handshake was per-CONNECTION rather than
    // consecutive: three drops across an hour-long call, each timing out once
    // before the next attempt answered, surfaced the permanent
    // "did not complete the session handshake" error against a healthy peer.
    core.connect();
    await vi.advanceTimersByTimeAsync(0);

    // One timeout, then a peer that answers properly.
    created[0]?.simulateOpen();
    await vi.advanceTimersByTimeAsync(10_000);
    const healthy = await waitForNextSocket(1);
    healthy.simulateOpen();
    healthy.simulateMessage(makeConfig());
    expect(core.getSnapshot().state).not.toBe("error");

    // The session drops later and the next two attempts time out. Counted from
    // the connection rather than consecutively that is the third strike and the
    // session dies; counted consecutively it is the second, so it re-dials.
    healthy.simulateClose();
    for (let i = 0; i < 2; i++) {
      const socket = await waitForNextSocket(created.length);
      socket.simulateOpen();
      await vi.advanceTimersByTimeAsync(10_000);
    }

    expect(core.getSnapshot().state).toBe("connecting");
    expect(core.getSnapshot().error).toBeNull();
  });

  it("a config frame disarms the deadline, so a healthy session is left alone", async () => {
    core.connect();
    await vi.advanceTimersByTimeAsync(0);
    created[0]?.simulateOpen();
    created[0]?.simulateMessage(makeConfig());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(core.getSnapshot().state).not.toBe("error");
    expect(created).toHaveLength(1);
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
